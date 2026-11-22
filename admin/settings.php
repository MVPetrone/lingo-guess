<?php
/**
 * Settings: where the operator installs the Google sign-in keys.
 *
 * Admin session + CSRF, POST-redirect-GET. The secret is write-only: the page
 * says whether one is set and never renders it, not even masked.
 */
declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/config_write.php';

security_headers();
$user = require_login_page();

if (strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $back = static function (string $query): never {
        header('Location: /admin/settings.php?' . $query, true, 303);
        exit;
    };
    if (!hash_equals(csrf_token(), (string) ($_POST['csrf'] ?? ''))) {
        $back('e=csrf');
    }
    if (!rate_limit('settings:' . ip_hash(), 10, 60)) {
        $back('e=rate');
    }
    $id = is_string($_POST['google_client_id'] ?? null) ? $_POST['google_client_id'] : '';
    $secret = is_string($_POST['google_client_secret'] ?? null) ? $_POST['google_client_secret'] : '';
    $next = config_with_google(app_config() ?? [], $id, $secret);
    if (is_string($next)) {
        $back('e=' . $next);
    }
    if (!config_write_atomic(STORAGE . '/config.php', $next)) {
        $back('e=write');
    }
    audit('settings_google', 'google sign-in keys updated', (string) $user['username']);
    $back('ok=1');
}

require_method('GET');

$csrf = csrf_token();
$status = config_google_status(app_config() ?? []);
$errors = [
    'csrf' => 'Session check failed. Reload the page and try again.',
    'rate' => 'Too many saves. Wait a minute.',
    'empty' => 'Nothing to save: both fields were empty.',
    'bad_id' => 'That does not look like a Google web client id (…apps.googleusercontent.com).',
    'bad_secret' => 'That does not look like a Google client secret.',
    'write' => 'Could not write the config file. Nothing was changed.',
];
$e = $_GET['e'] ?? '';
$error = $errors[is_string($e) ? $e : ''] ?? '';
$saved = ($_GET['ok'] ?? '') === '1';
?>
<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Settings · Lingo Guess Admin</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/fonts/fonts.css" />
<link rel="stylesheet" href="/admin/assets/admin.css" />
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true"></span>
    <div><strong>Lingo Guess</strong><small>Admin · CRM</small></div>
  </div>
  <div class="spacer"></div>
  <span class="who"><?= h((string) $user['username']) ?></span>
  <form method="post" action="/admin/logout.php">
    <input type="hidden" name="csrf" value="<?= h($csrf) ?>" />
    <button class="ghost" type="submit">Sign out</button>
  </form>
</header>

<nav class="tabs">
  <a href="/admin/dashboard.php">Traffic</a>
  <a href="/admin/activity.php">Activity</a>
  <a class="soon" title="Next milestone">Contacts</a>
  <a class="soon" title="Next milestone">Pipeline</a>
  <a class="on" href="/admin/settings.php">Settings</a>
</nav>

<main class="wrap">
  <h2 class="mb">Google sign-in</h2>

  <div class="panel settings">
    <?php if ($error !== ''): ?>
      <p class="alert" role="alert"><?= h($error) ?></p>
    <?php elseif ($saved): ?>
      <p class="notice" role="status">Saved. New sign-ins use these keys straight away.</p>
    <?php endif; ?>

    <dl class="settings-status">
      <dt>Client id</dt>
      <dd data-testid="client-id-status">
        <?php if ($status['client_id_set']): ?>
          set · ends <code>…<?= h($status['client_id_tail']) ?>.apps.googleusercontent.com</code>
        <?php else: ?>
          not set
        <?php endif; ?>
      </dd>
      <dt>Client secret</dt>
      <dd data-testid="client-secret-status"><?= $status['secret_set'] ? 'set' : 'not set' ?></dd>
      <dt>Redirect URI to register</dt>
      <dd><code><?= h(google_redirect_uri()) ?></code></dd>
      <?php if ($status['updated_at'] !== null): ?>
        <dt>Last changed</dt>
        <dd><?= h(uk_date($status['updated_at'], 'd M Y H:i')) ?></dd>
      <?php endif; ?>
    </dl>

    <form method="post" action="/admin/settings.php" autocomplete="off">
      <input type="hidden" name="csrf" value="<?= h($csrf) ?>" />
      <label for="gid">Client id</label>
      <input id="gid" name="google_client_id" type="text" maxlength="200" spellcheck="false"
             autocapitalize="none" placeholder="<?= $status['client_id_set'] ? 'leave empty to keep the current id' : '1234…apps.googleusercontent.com' ?>" />
      <label for="gsecret">Client secret</label>
      <input id="gsecret" name="google_client_secret" type="password" maxlength="128"
             autocomplete="new-password" placeholder="<?= $status['secret_set'] ? 'leave empty to keep the current secret' : 'GOCSPX-…' ?>" />
      <button type="submit">Save</button>
    </form>

    <p class="fineprint">
      Written to <code>storage/config.php</code> (outside the webroot, mode 0600) and never shown again.
      Empty fields keep what is stored.
    </p>
  </div>
</main>
</body>
</html>
