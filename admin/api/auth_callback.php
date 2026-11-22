<?php
/**
 * Google redirects here with `code` + `state`.
 *
 * Order matters: the state is checked against the cookie (constant time) and
 * the cookie is burnt before anything else, so a code can be tried once. The
 * code is exchanged server-side with the client secret, and the id_token is
 * only trusted after its RS256 signature and claims check out. Every failure
 * is the same opaque redirect with a short reason code.
 */
declare(strict_types=1);

require __DIR__ . '/../lib/bootstrap.php';

security_headers(true);
require_method('GET');

if (!is_installed() || google_credentials() === null) {
    signin_redirect('unavailable');
}

if (!rate_limit('auth_callback:' . ip_hash(), 10, 60)) {
    signin_redirect('rate_limited');
}

// Read and burn the one-time cookie whatever happens next.
$cookie = $_COOKIE[OAUTH_COOKIE] ?? null;
oauth_cookie('', 0);

if (isset($_GET['error'])) {
    signin_redirect('cancelled'); // the player backed out at Google
}

if (!is_string($cookie) || !preg_match('/^([a-f0-9]{64}):([A-Za-z0-9_-]{43,128})$/', $cookie, $m)) {
    signin_redirect('state');
}
[, $expectedState, $verifier] = $m;

$state = $_GET['state'] ?? null;
if (!is_string($state) || !hash_equals($expectedState, $state)) {
    signin_redirect('state');
}

$code = $_GET['code'] ?? null;
if (!is_string($code) || !preg_match('/^[\x21-\x7E]{10,1024}$/', $code)) {
    signin_redirect('code');
}

$idToken = google_exchange_code($code, $verifier);
if ($idToken === null) {
    signin_redirect('exchange');
}

$identity = google_verify_id_token($idToken);
if ($identity === null) {
    signin_redirect('token');
}

$pdo = db();
$now = time();
$stmt = $pdo->prepare(
    'INSERT INTO players (google_sub, email, name, picture, created_at, last_login)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(google_sub) DO UPDATE SET
       email = excluded.email, name = excluded.name, picture = excluded.picture, last_login = excluded.last_login
     RETURNING id'
);
$stmt->execute([$identity['sub'], $identity['email'], $identity['name'], $identity['picture'], $now, $now]);
$playerId = (int) $stmt->fetchColumn();
$stmt->closeCursor();
if ($playerId <= 0) {
    signin_redirect('server');
}

// A fresh session every sign-in; whatever the browser held before is dropped.
destroy_player_session();
player_cookie_set(create_player_session($playerId));
audit('player_signin');

signin_redirect();
