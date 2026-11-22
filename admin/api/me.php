<?php
/** Who is signed in, if anyone. The game calls this once on boot. */
declare(strict_types=1);

require __DIR__ . '/../lib/bootstrap.php';

security_headers(true);

if (!is_installed()) {
    json_out(['error' => 'not_installed'], 503);
}

require_method('GET');

if (!rate_limit('me:' . ip_hash(), 120, 60)) {
    json_out(['error' => 'rate_limited'], 429);
}

$player = current_player();
if ($player === null) {
    // A stale or forged cookie is dropped so the browser stops sending it.
    if (isset($_COOKIE[PLAYER_COOKIE])) {
        player_cookie_clear();
    }
    json_out(['signed_in' => false]);
}

json_out([
    'signed_in' => true,
    'name' => $player['name'],
    'picture' => $player['picture'],
    'email' => $player['email'],
    'data_updated_at' => $player['data_updated_at'],
]);
