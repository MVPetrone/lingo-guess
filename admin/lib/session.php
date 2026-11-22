<?php
/**
 * Player sessions (Google sign-in), separate from the admin's PHP session.
 *
 * The cookie holds a 256-bit random token; the database keeps only its
 * SHA-256, so a copy of crm.sqlite cannot be replayed as a live session.
 */
declare(strict_types=1);

// Included by the entry points only — never served directly.
if (!defined('ADMIN_DIR')) {
    http_response_code(404);
    exit;
}

const PLAYER_COOKIE = 'lingo_sess';
const PLAYER_SESSION_TTL = 90 * 86400;  // absolute: 90 days from sign-in
const PLAYER_TOUCH_EVERY = 3600;        // last_seen is written at most hourly

function player_cookie_set(string $token): void
{
    setcookie(PLAYER_COOKIE, $token, [
        'expires' => time() + PLAYER_SESSION_TTL,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function player_cookie_clear(): void
{
    setcookie(PLAYER_COOKIE, '', [
        'expires' => time() - 86400,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function session_token_hash(string $token): string
{
    return hash('sha256', $token);
}

/** The raw cookie token if it has the exact shape we issue, else null. */
function player_cookie_token(): ?string
{
    $token = $_COOKIE[PLAYER_COOKIE] ?? null;
    return is_string($token) && is_token($token, 64) ? $token : null;
}

/** New session row for a player; returns the token for the cookie. */
function create_player_session(int $playerId): string
{
    $token = bin2hex(random_bytes(32));
    $now = time();
    db()->prepare('INSERT INTO sessions (id, player_id, created_at, last_seen, ip_hash, ua) VALUES (?, ?, ?, ?, ?, ?)')
        ->execute([
            session_token_hash($token),
            $playerId,
            $now,
            $now,
            ip_hash(),
            clean_str($_SERVER['HTTP_USER_AGENT'] ?? '', 200),
        ]);
    return $token;
}

/** Deletes the session the current cookie points at, if any. */
function destroy_player_session(): void
{
    $token = player_cookie_token();
    if ($token !== null) {
        db()->prepare('DELETE FROM sessions WHERE id = ?')->execute([session_token_hash($token)]);
    }
}

/**
 * The signed-in player, or null. A session older than 90 days is deleted on
 * sight; a live one has `last_seen` extended (hourly, to keep writes rare).
 */
function current_player(): ?array
{
    static $cached = false;
    if ($cached !== false) {
        return $cached;
    }
    $token = player_cookie_token();
    if ($token === null) {
        return $cached = null;
    }
    $id = session_token_hash($token);
    $stmt = db()->prepare(
        'SELECT s.created_at AS s_created, s.last_seen AS s_seen,
                p.id, p.email, p.name, p.picture, p.data_updated_at
         FROM sessions s JOIN players p ON p.id = s.player_id
         WHERE s.id = ?'
    );
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) {
        return $cached = null;
    }
    $now = time();
    if ((int) $row['s_created'] < $now - PLAYER_SESSION_TTL) {
        db()->prepare('DELETE FROM sessions WHERE id = ?')->execute([$id]);
        return $cached = null;
    }
    if ((int) $row['s_seen'] < $now - PLAYER_TOUCH_EVERY) {
        db()->prepare('UPDATE sessions SET last_seen = ? WHERE id = ?')->execute([$now, $id]);
    }
    return $cached = [
        'id' => (int) $row['id'],
        'email' => (string) $row['email'],
        'name' => $row['name'] === null ? null : (string) $row['name'],
        'picture' => $row['picture'] === null ? null : (string) $row['picture'],
        'data_updated_at' => (int) $row['data_updated_at'],
    ];
}

/** API guard: 401 JSON without a live session. */
function require_session(): array
{
    $player = current_player();
    if ($player === null) {
        json_out(['error' => 'unauthorized'], 401);
    }
    return $player;
}

/**
 * Writes must carry `X-Lingo-Client: 1`. A cross-site form or image cannot set
 * a custom header, and a cross-site fetch that does triggers a CORS preflight
 * this server never approves — so SameSite=Lax is not the only CSRF guard.
 */
function require_client_header(): void
{
    if (($_SERVER['HTTP_X_LINGO_CLIENT'] ?? '') !== '1') {
        json_out(['error' => 'forbidden'], 403);
    }
}

/**
 * Sign-in endpoints are top-level navigations, so they answer with a redirect
 * back into the game, never a JSON page. `$reason` is one of our own short
 * codes; nothing from the request or from Google is ever put in the URL.
 */
function signin_redirect(?string $reason = null): never
{
    http_response_code(302);
    header('Location: ' . ($reason === null ? '/?signed_in=1' : '/?signin=error&reason=' . rawurlencode($reason)));
    exit;
}

const OAUTH_COOKIE = 'lingo_oauth';
const OAUTH_TTL = 600;

function oauth_cookie(string $value, int $ttl): void
{
    setcookie(OAUTH_COOKIE, $value, [
        'expires' => $ttl > 0 ? time() + $ttl : time() - 86400,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/** First-party Origin (or Referer) for player writes; also accepts the configured origin. */
function require_player_origin(): void
{
    if (!is_first_party_request([canonical_origin()])) {
        json_out(['error' => 'forbidden_origin'], 403);
    }
}
