<?php
/**
 * Google sign-in plumbing: the canonical origin, the server-side code exchange,
 * the JWKS cache and RS256 id_token verification.
 *
 * Every failure returns null (or false) and logs a short reason; callers turn
 * that into one opaque error code. Nothing from Google's responses is echoed.
 */
declare(strict_types=1);

// Included by the entry points only — never served directly.
if (!defined('ADMIN_DIR')) {
    http_response_code(404);
    exit;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const JWKS_TTL = 86400;          // cached keys are trusted for 24 h
const JWKS_REFETCH_MIN = 300;    // an unknown kid refetches at most every 5 min
const CLOCK_SKEW = 120;          // seconds of drift tolerated on exp / iat

/** `https://lingoguess.com` unless config overrides it (local dev: `http://localhost:8099`). */
function canonical_origin(): string
{
    $cfg = app_config() ?: [];
    $origin = is_string($cfg['canonical_origin'] ?? null) ? rtrim($cfg['canonical_origin'], '/') : '';
    if (preg_match('#^https?://[a-z0-9.-]+(:\d{1,5})?$#', $origin)) {
        return $origin;
    }
    return 'https://lingoguess.com';
}

function google_redirect_uri(): string
{
    return canonical_origin() . '/admin/api/auth_callback.php';
}

/** [client_id, client_secret], or null while the operator has not installed them. */
function google_credentials(): ?array
{
    $cfg = app_config() ?: [];
    $id = $cfg['google_client_id'] ?? '';
    $secret = $cfg['google_client_secret'] ?? '';
    if (!is_string($id) || !is_string($secret) || $id === '' || $secret === '') {
        return null;
    }
    return [$id, $secret];
}

function b64url_encode(string $bin): string
{
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

/** Strict: anything outside the base64url alphabet is null, not silently dropped. */
function b64url_decode(string $s): ?string
{
    if ($s === '' || !preg_match('/^[A-Za-z0-9_-]+$/', $s)) {
        return null;
    }
    $pad = strlen($s) % 4;
    if ($pad === 1) {
        return null;
    }
    $out = base64_decode(strtr($s, '-_', '+/') . str_repeat('=', $pad ? 4 - $pad : 0), true);
    return $out === false ? null : $out;
}

/** PKCE S256 challenge for a verifier. */
function pkce_challenge(string $verifier): string
{
    return b64url_encode(hash('sha256', $verifier, true));
}

/**
 * One HTTPS request to Google: 5 s to connect, 10 s in total, TLS verified,
 * no redirects followed. Returns [status, body] or null on transport failure.
 */
function google_http(string $method, string $url, ?array $form = null): ?array
{
    if (!function_exists('curl_init')) {
        error_log('google_http: curl extension missing');
        return null;
    }
    $ch = curl_init($url);
    if ($ch === false) {
        return null;
    }
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
        CURLOPT_USERAGENT => 'lingoguess-auth/1.0',
    ];
    if ($method === 'POST') {
        $opts[CURLOPT_POST] = true;
        $opts[CURLOPT_POSTFIELDS] = http_build_query($form ?? [], '', '&', PHP_QUERY_RFC3986);
    }
    curl_setopt_array($ch, $opts);
    $body = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $errno = curl_errno($ch);
    unset($ch); // curl_close() is a deprecated no-op since PHP 8
    if ($errno !== 0 || !is_string($body)) {
        error_log('google_http: transport error ' . $errno . ' for ' . parse_url($url, PHP_URL_HOST));
        return null;
    }
    return [$status, $body];
}

/** Exchanges an authorization code for the id_token. Null on any failure. */
function google_exchange_code(string $code, string $verifier): ?string
{
    $creds = google_credentials();
    if ($creds === null) {
        return null;
    }
    $res = google_http('POST', GOOGLE_TOKEN_URL, [
        'code' => $code,
        'client_id' => $creds[0],
        'client_secret' => $creds[1],
        'redirect_uri' => google_redirect_uri(),
        'grant_type' => 'authorization_code',
        'code_verifier' => $verifier,
    ]);
    if ($res === null) {
        return null;
    }
    [$status, $body] = $res;
    if ($status !== 200) {
        error_log('google_exchange_code: token endpoint returned ' . $status);
        return null;
    }
    $json = json_decode($body, true);
    $idToken = is_array($json) ? ($json['id_token'] ?? null) : null;
    return is_string($idToken) && strlen($idToken) < 8192 ? $idToken : null;
}

// ---- JWKS ----------------------------------------------------------------------

function jwks_cache_file(): string
{
    return STORAGE . '/jwks.json';
}

/** Only RSA signing keys with a kid survive; everything else is dropped. */
function jwks_clean(mixed $doc): array
{
    $keys = [];
    foreach ((is_array($doc) && is_array($doc['keys'] ?? null)) ? $doc['keys'] : [] as $k) {
        if (!is_array($k) || ($k['kty'] ?? '') !== 'RSA' || !is_string($k['kid'] ?? null)
            || !is_string($k['n'] ?? null) || !is_string($k['e'] ?? null)) {
            continue;
        }
        if (isset($k['use']) && $k['use'] !== 'sig') {
            continue;
        }
        if (isset($k['alg']) && $k['alg'] !== 'RS256') {
            continue;
        }
        $keys[$k['kid']] = ['n' => $k['n'], 'e' => $k['e']];
    }
    return $keys;
}

function jwks_read_cache(): ?array
{
    $file = jwks_cache_file();
    if (!is_file($file)) {
        return null;
    }
    $doc = json_decode((string) @file_get_contents($file), true);
    if (!is_array($doc) || !is_int($doc['fetched_at'] ?? null) || !is_array($doc['keys'] ?? null)) {
        return null;
    }
    return $doc;
}

/** Fetches Google's keys and caches them atomically. Null on any failure. */
function jwks_fetch(): ?array
{
    $res = google_http('GET', GOOGLE_JWKS_URL);
    if ($res === null || $res[0] !== 200) {
        error_log('jwks_fetch: failed' . ($res === null ? '' : ' with ' . $res[0]));
        return null;
    }
    $keys = jwks_clean(json_decode($res[1], true));
    if ($keys === []) {
        error_log('jwks_fetch: no usable keys');
        return null;
    }
    $doc = ['fetched_at' => time(), 'keys' => $keys];
    $file = jwks_cache_file();
    $tmp = $file . '.' . bin2hex(random_bytes(6)) . '.tmp';
    if (@file_put_contents($tmp, json_encode($doc), LOCK_EX) !== false) {
        @chmod($tmp, 0600);
        if (!@rename($tmp, $file)) {
            @unlink($tmp);
        }
    }
    return $doc;
}

/**
 * The public key parts for `kid`. A fresh cache answers directly; a stale one or
 * an unknown kid refetches. Fails closed: if Google cannot be reached and the
 * cache is stale, there is no key and the token is rejected.
 */
function jwks_key(string $kid): ?array
{
    $doc = jwks_read_cache();
    $age = $doc === null ? PHP_INT_MAX : time() - $doc['fetched_at'];
    if ($doc !== null && $age < JWKS_TTL && isset($doc['keys'][$kid])) {
        return $doc['keys'][$kid];
    }
    // Unknown kid on a fresh cache: Google rotated. Refetch, but not on every
    // forged kid — at most once per JWKS_REFETCH_MIN.
    if ($doc !== null && $age < JWKS_REFETCH_MIN) {
        return null;
    }
    $doc = jwks_fetch();
    return $doc['keys'][$kid] ?? null;
}

// ---- RS256 ---------------------------------------------------------------------

function asn1_len(int $len): string
{
    if ($len < 0x80) {
        return chr($len);
    }
    $bytes = ltrim(pack('N', $len), "\0");
    return chr(0x80 | strlen($bytes)) . $bytes;
}

function asn1_int(string $bytes): string
{
    $bytes = ltrim($bytes, "\0");
    if ($bytes === '' || ord($bytes[0]) & 0x80) {
        $bytes = "\0" . $bytes;
    }
    return "\x02" . asn1_len(strlen($bytes)) . $bytes;
}

/** PEM SubjectPublicKeyInfo for an RSA JWK's base64url `n` and `e`. Null if malformed. */
function jwk_to_pem(string $n, string $e): ?string
{
    $mod = b64url_decode($n);
    $exp = b64url_decode($e);
    if ($mod === null || $exp === null || strlen(ltrim($mod, "\0")) < 256 || strlen($exp) > 8) {
        return null; // < 2048-bit moduli are refused outright
    }
    $rsaKey = "\x30" . asn1_len(strlen(asn1_int($mod) . asn1_int($exp))) . asn1_int($mod) . asn1_int($exp);
    $bitString = "\x03" . asn1_len(strlen($rsaKey) + 1) . "\x00" . $rsaKey;
    // AlgorithmIdentifier: rsaEncryption (1.2.840.113549.1.1.1) + NULL
    $algo = "\x30\x0d\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00";
    $spki = "\x30" . asn1_len(strlen($algo . $bitString)) . $algo . $bitString;
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
}

/**
 * Verifies a compact JWS signed with RS256 and returns its claims, or null.
 * `$keyFor` maps a kid to ['n' => …, 'e' => …] (injected so tests can run offline).
 */
function jwt_verify_rs256(string $jwt, callable $keyFor): ?array
{
    $parts = explode('.', $jwt);
    if (count($parts) !== 3) {
        return null;
    }
    [$h64, $p64, $s64] = $parts;
    $header = json_decode((string) b64url_decode($h64), true);
    if (!is_array($header) || ($header['alg'] ?? '') !== 'RS256' || !is_string($header['kid'] ?? null)
        || strlen($header['kid']) > 128) {
        return null;
    }
    $sig = b64url_decode($s64);
    $key = $keyFor($header['kid']);
    if ($sig === null || !is_array($key)) {
        return null;
    }
    $pem = jwk_to_pem((string) ($key['n'] ?? ''), (string) ($key['e'] ?? ''));
    $pub = $pem === null ? false : openssl_pkey_get_public($pem);
    if ($pub === false) {
        return null;
    }
    if (openssl_verify($h64 . '.' . $p64, $sig, $pub, OPENSSL_ALGO_SHA256) !== 1) {
        return null;
    }
    $claims = json_decode((string) b64url_decode($p64), true);
    return is_array($claims) ? $claims : null;
}

/**
 * The checks Google documents for an id_token, on already signature-verified
 * claims. Returns the identity we keep, or null.
 */
function google_check_claims(array $c, string $clientId, int $now): ?array
{
    if (!in_array($c['iss'] ?? null, GOOGLE_ISSUERS, true)) {
        return null;
    }
    if (($c['aud'] ?? null) !== $clientId) {
        return null;
    }
    $exp = $c['exp'] ?? null;
    $iat = $c['iat'] ?? null;
    if (!is_int($exp) || !is_int($iat) || $exp + CLOCK_SKEW < $now || $iat - CLOCK_SKEW > $now
        || $exp <= $iat || $exp - $iat > 86400) {
        return null;
    }
    $verified = $c['email_verified'] ?? null;
    if ($verified !== true && $verified !== 'true') {
        return null;
    }
    $sub = $c['sub'] ?? null;
    $email = $c['email'] ?? null;
    if (!is_string($sub) || !preg_match('/^[0-9A-Za-z_-]{1,255}$/', $sub)) {
        return null;
    }
    if (!is_string($email) || strlen($email) > 254 || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
        return null;
    }
    $picture = is_string($c['picture'] ?? null) ? $c['picture'] : '';
    if (strlen($picture) > 500 || !preg_match('#^https://[a-z0-9-]+\.googleusercontent\.com/[\x21-\x7E]*$#', $picture)) {
        $picture = '';
    }
    $name = clean_str($c['name'] ?? '', 100);
    return [
        'sub' => $sub,
        'email' => strtolower($email),
        'name' => $name === '' ? null : $name,
        'picture' => $picture === '' ? null : $picture,
    ];
}

/** Full verification of a freshly exchanged id_token against the live JWKS. */
function google_verify_id_token(string $jwt): ?array
{
    $creds = google_credentials();
    if ($creds === null) {
        return null;
    }
    $claims = jwt_verify_rs256($jwt, 'jwks_key');
    return $claims === null ? null : google_check_claims($claims, $creds[0], time());
}
