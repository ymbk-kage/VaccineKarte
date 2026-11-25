<?php
// Site settings for the shared PHP hosting deployment (counterpart of wrangler.jsonc "vars").
// Nothing here is secret: the service-account key lives in ServiceAccount.php next to this file
// (created from your key JSON at deploy time, never committed; see README). It is a PHP file on purpose:
// shared PHP hosting always executes .php, so the key can never be handed out as a static file, even past a broken deny
// rule or from a front-end cache that keeps serving static files.
declare(strict_types=1);

return [
    // Spreadsheet that holds the vaccine pre-screening records (VACCINE_SHEET_ID; empty = not configured)
    'sheetId' => getenv('VACCINE_SHEET_ID') ?: '',
    // Worksheet name (VACCINE_SHEET_NAME overrides the default)
    'sheetName' => getenv('VACCINE_SHEET_NAME') ?: '患者管理',
    // Google Drive folder that holds attachment files, named in the attachment error message
    // (VACCINE_ATTACHMENT_FOLDER; empty = the message says "the shared folder" without a name)
    'attachmentFolder' => getenv('VACCINE_ATTACHMENT_FOLDER') ?: '',
    // Service-account key file; the environment variable lets local real-sheet runs point elsewhere
    'serviceAccountPath' => getenv('VACCINE_SA_JSON_PATH') ?: __DIR__ . '/ServiceAccount.php',
    // Encrypted caches (sheet snapshot, access token) and request logs
    // (the environment variables are only for local runs, so fixture caches never land in the repository)
    'cacheDir' => getenv('VACCINE_CACHE_DIR') ?: __DIR__ . '/Cache',
    'logDir' => getenv('VACCINE_LOG_DIR') ?: __DIR__ . '/Logs',
];
