<?php
/**
 * Offline unit tests for lib/google.php (RS256 + claims + JWKS fail-closed)
 * and lib/config_write.php (validation, merge, atomic write, redaction).
 *
 *     php tests/security/test_google_lib.php
 *
 * No network, no real credentials: keys are generated per run.
 */
declare(strict_types=1);

$tmp = sys_get_temp_dir() . '/lingo-libtest-' . bin2hex(random_bytes(4));
mkdir($tmp, 0700);
define('ADMIN_DIR', dirname(__DIR__, 2) . '/server/admin');
define('STORAGE', $tmp);
ini_set('error_log', $tmp . '/php.log');

$TEST_CONFIG = ['app_secret' => 'test', 'google_client_id' => '123456789-abcdefghijklmnop.apps.googleusercontent.com', 'google_client_secret' => 'GOCSPX-unit-test-not-a-secret'];
function app_config(): ?array
{
    return $GLOBALS['TEST_CONFIG'];
}

require ADMIN_DIR . '/lib/util.php';
require ADMIN_DIR . '/lib/google.php';
require ADMIN_DIR . '/lib/config_write.php';

$fails = 0;
$passes = 0;
function check(string $name, bool $ok): void
{
    global $fails, $passes;
    echo ($ok ? '  PASS  ' : '  FAIL  ') . $name . "\n";
    $ok ? $passes++ : $fails++;
}

function rsa_jwk(int $bits = 2048): array
{
    $key = openssl_pkey_new(['private_key_bits' => $bits, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
    $d = openssl_pkey_get_details($key);
    return [$key, ['n' => b64url_encode($d['rsa']['n']), 'e' => b64url_encode($d['rsa']['e'])]];
}

function sign_jwt(array $header, array $claims, $key): string
{
    $h = b64url_encode(json_encode($header));
    $p = b64url_encode(json_encode($claims));
    openssl_sign("$h.$p", $sig, $key, OPENSSL_ALGO_SHA256);
    return "$h.$p." . b64url_encode($sig);
}

$now = time();
$clientId = $TEST_CONFIG['google_client_id'];
$claims = [
    'iss' => 'https://accounts.google.com', 'aud' => $clientId, 'sub' => '110169484474386276334',
    'email' => 'Player@Example.com', 'email_verified' => true, 'name' => "Ada <b>Lovelace</b>\x07",
    'picture' => 'https://lh3.googleusercontent.com/a/abc=s96-c', 'iat' => $now - 10, 'exp' => $now + 3590,
];

echo "RS256\n";
[$key, $jwk] = rsa_jwk();
$keys = ['k1' => $jwk];
$keyFor = static fn (string $kid) => $keys[$kid] ?? null;

$jwt = sign_jwt(['alg' => 'RS256', 'kid' => 'k1', 'typ' => 'JWT'], $claims, $key);
check('a correctly signed token verifies', jwt_verify_rs256($jwt, $keyFor) === $claims);

[$h, $p, $s] = explode('.', $jwt);
$forged = b64url_encode(json_encode(['sub' => 'attacker'] + $claims));
check('a tampered payload is rejected', jwt_verify_rs256("$h.$forged.$s", $keyFor) === null);
check('an unknown kid is rejected', jwt_verify_rs256(sign_jwt(['alg' => 'RS256', 'kid' => 'nope'], $claims, $key), $keyFor) === null);
check('alg=none is rejected', jwt_verify_rs256(b64url_encode('{"alg":"none","kid":"k1"}') . ".$p.", $keyFor) === null);
check('alg=HS256 is rejected', jwt_verify_rs256(b64url_encode('{"alg":"HS256","kid":"k1"}') . ".$p.$s", $keyFor) === null);
[$other] = rsa_jwk();
check('a token signed by another key is rejected', jwt_verify_rs256(sign_jwt(['alg' => 'RS256', 'kid' => 'k1'], $claims, $other), $keyFor) === null);
check('two-part and four-part tokens are rejected', jwt_verify_rs256("$h.$p", $keyFor) === null && jwt_verify_rs256("$jwt.x", $keyFor) === null);
check('non-base64url signature is rejected', jwt_verify_rs256("$h.$p.+/+/", $keyFor) === null);
[$weak, $weakJwk] = rsa_jwk(1024);
check('a 1024-bit key is refused', jwt_verify_rs256(sign_jwt(['alg' => 'RS256', 'kid' => 'w'], $claims, $weak), static fn () => $weakJwk) === null);

echo "claims\n";
$id = google_check_claims($claims, $clientId, $now);
check('valid claims give the identity', is_array($id) && $id['sub'] === $claims['sub'] && $id['email'] === 'player@example.com');
check('name is cleaned of control characters', $id !== null && !str_contains((string) $id['name'], "\x07"));
check('googleusercontent picture is kept', $id !== null && $id['picture'] === $claims['picture']);
check('a foreign picture host is dropped', google_check_claims(['picture' => 'https://evil.example/x.png'] + $claims, $clientId, $now)['picture'] === null);
check('iss without scheme is accepted', google_check_claims(['iss' => 'accounts.google.com'] + $claims, $clientId, $now) !== null);
check('a foreign iss is rejected', google_check_claims(['iss' => 'https://evil.example'] + $claims, $clientId, $now) === null);
check('a different aud is rejected', google_check_claims(['aud' => 'other.apps.googleusercontent.com'] + $claims, $clientId, $now) === null);
check('an aud array is rejected', google_check_claims(['aud' => [$clientId]] + $claims, $clientId, $now) === null);
check('an expired token is rejected', google_check_claims(['exp' => $now - 600, 'iat' => $now - 4200] + $claims, $clientId, $now) === null);
check('an iat in the future is rejected', google_check_claims(['iat' => $now + 900, 'exp' => $now + 4500] + $claims, $clientId, $now) === null);
check('a lifetime over a day is rejected', google_check_claims(['exp' => $now + 90000] + $claims, $clientId, $now) === null);
check('email_verified=false is rejected', google_check_claims(['email_verified' => false] + $claims, $clientId, $now) === null);
check('missing email_verified is rejected', google_check_claims(array_diff_key($claims, ['email_verified' => 1]), $clientId, $now) === null);
check('email_verified="true" is accepted', google_check_claims(['email_verified' => 'true'] + $claims, $clientId, $now) !== null);
check('a malformed email is rejected', google_check_claims(['email' => 'not-an-email'] + $claims, $clientId, $now) === null);
check('a missing sub is rejected', google_check_claims(array_diff_key($claims, ['sub' => 1]), $clientId, $now) === null);

echo "JWKS cache\n";
check('no cache + no reachable Google = no key (fails closed)', jwks_key('k1') === null || !function_exists('curl_init'));
file_put_contents(jwks_cache_file(), json_encode(['fetched_at' => $now - 60, 'keys' => $keys]));
check('a fresh cache answers without the network', jwks_key('k1') === $jwk);
check('an unknown kid on a fresh cache is not refetched in a loop', jwks_key('forged') === null);
file_put_contents(jwks_cache_file(), json_encode(['fetched_at' => $now - JWKS_TTL - 1, 'keys' => $keys]));
check('a stale cache is not trusted when Google is unreachable', function_exists('curl_init') || jwks_key('k1') === null);
check('jwks_clean keeps only RSA sig keys with a kid', array_keys(jwks_clean(['keys' => [
    ['kty' => 'RSA', 'kid' => 'a', 'n' => 'x', 'e' => 'AQAB', 'use' => 'sig', 'alg' => 'RS256'],
    ['kty' => 'RSA', 'kid' => 'b', 'n' => 'x', 'e' => 'AQAB', 'use' => 'enc'],
    ['kty' => 'EC', 'kid' => 'c', 'x' => 'x', 'y' => 'y'],
    ['kty' => 'RSA', 'n' => 'x', 'e' => 'AQAB'],
]])) === ['a']);

echo "PKCE / origin\n";
// RFC 7636 appendix B test vector.
check('S256 challenge matches RFC 7636', pkce_challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk') === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
check('redirect URI is built from the canonical origin', google_redirect_uri() === 'https://lingoguess.com/admin/api/auth_callback.php');
$TEST_CONFIG['canonical_origin'] = 'http://localhost:8099/';
check('a configured origin is honoured', canonical_origin() === 'http://localhost:8099');
$TEST_CONFIG['canonical_origin'] = 'javascript:alert(1)//';
check('a junk origin falls back to the default', canonical_origin() === 'https://lingoguess.com');
unset($TEST_CONFIG['canonical_origin']);

echo "config_write\n";
$base = ['app_secret' => 'keep-me', 'installed_at' => 1, 'installed_by' => 'admin'];
$gid = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com';
$gsecret = 'GOCSPX-' . str_repeat('A', 28);
$next = config_with_google($base, "  $gid ", $gsecret);
check('merge keeps every other key', is_array($next) && $next['app_secret'] === 'keep-me' && $next['installed_by'] === 'admin');
check('merge stores trimmed id and secret', is_array($next) && $next['google_client_id'] === $gid && $next['google_client_secret'] === $gsecret);
check('both empty is refused', config_with_google($base, '', ' ') === 'empty');
check('a bad id is refused', config_with_google($base, 'evil\'];system("id");//', '') === 'bad_id');
check('a bad secret is refused', config_with_google($base, '', "x'; ?><?php phpinfo();") === 'bad_secret');
$idOnly = config_with_google($next, '999999999-zyxwvutsrqponmlk.apps.googleusercontent.com', '');
check('an empty secret keeps the stored secret', is_array($idOnly) && $idOnly['google_client_secret'] === $gsecret);

$target = $tmp . '/config.php';
file_put_contents($target, config_render($base));
check('atomic write succeeds', config_write_atomic($target, $next));
check('written file is mode 0600', (fileperms($target) & 0777) === 0600);
check('written file loads back identically', (require $target) === $next);
check('no temp files are left behind', glob($tmp . '/.config.*') === []);
check('rendered config is valid PHP', str_starts_with(config_render($next), "<?php\n"));

$status = config_google_status($next);
check('status reports both keys set', $status['client_id_set'] && $status['secret_set']);
check('status shows 12 distinguishing id characters', $status['client_id_tail'] === 'uvwxyz012345');
check('status never contains the secret', !str_contains(json_encode($status), $gsecret) && !str_contains(json_encode($status), 'GOCSPX'));
check('status of an empty config says not set', config_google_status($base) === ['client_id_set' => false, 'client_id_tail' => '', 'secret_set' => false, 'updated_at' => null]);

foreach (scandir($tmp) ?: [] as $f) {
    if ($f !== '.' && $f !== '..') {
        @unlink($tmp . '/' . $f);
    }
}
@rmdir($tmp);

echo "\n$passes/" . ($passes + $fails) . " checks passed\n";
exit($fails === 0 ? 0 : 1);
