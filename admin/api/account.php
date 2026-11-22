<?php
/**
 * Erasure: hard-deletes the player row. Sessions go with it (ON DELETE
 * CASCADE, foreign_keys is on for every connection). No soft-delete flag,
 * no tombstone; the audit line carries no personal data.
 */
declare(strict_types=1);

require __DIR__ . '/../lib/bootstrap.php';

security_headers(true);

if (!is_installed()) {
    json_out(['error' => 'not_installed'], 503);
}

require_method('DELETE');
require_client_header();
require_player_origin();
$player = require_session();

db()->prepare('DELETE FROM players WHERE id = ?')->execute([$player['id']]);
player_cookie_clear();
audit('player_delete', 'account erased');

http_response_code(204);
exit;
