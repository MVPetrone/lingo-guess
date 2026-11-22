<?php
/**
 * Starts Google sign-in: OAuth 2.0 authorization code + PKCE (S256).
 *
 * The state and the PKCE verifier live only in an HttpOnly cookie for ten
 * minutes; Google only ever sees the state and the challenge.
 */
declare(strict_types=1);

require __DIR__ . '/../lib/bootstrap.php';

security_headers(true);
require_method('GET');

if (!is_installed()) {
    signin_redirect('unavailable');
}

if (!rate_limit('auth_start:' . ip_hash(), 10, 60)) {
    signin_redirect('rate_limited');
}

$creds = google_credentials();
if ($creds === null) {
    signin_redirect('unavailable');
}

$state = bin2hex(random_bytes(32));
$verifier = b64url_encode(random_bytes(48)); // 64 chars, inside RFC 7636's 43–128

oauth_cookie($state . ':' . $verifier, OAUTH_TTL);

$query = http_build_query([
    'client_id' => $creds[0],
    'redirect_uri' => google_redirect_uri(),
    'response_type' => 'code',
    'scope' => 'openid email profile',
    'state' => $state,
    'code_challenge' => pkce_challenge($verifier),
    'code_challenge_method' => 'S256',
    'prompt' => 'select_account',
], '', '&', PHP_QUERY_RFC3986);

http_response_code(302);
header('Location: ' . GOOGLE_AUTH_URL . '?' . $query);
exit;
