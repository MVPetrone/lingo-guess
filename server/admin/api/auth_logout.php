<?php
/** Ends the player's session: the row goes, the cookie goes. */
declare(strict_types=1);

require __DIR__ . '/../lib/bootstrap.php';

security_headers(true);

if (!is_installed()) {
    json_out(['error' => 'not_installed'], 503);
}

require_method('POST');
require_client_header();
require_player_origin();
require_session();

destroy_player_session();
player_cookie_clear();

http_response_code(204);
exit;
