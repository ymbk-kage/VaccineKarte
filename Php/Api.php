<?php
// Front controller for /api/* (the root .htaccess rewrites every /api/ path here).
// Static files never pass through PHP in production: Apache serves them after Basic authentication.
declare(strict_types=1);

require_once __DIR__ . '/Private/Lib/App.php';

// Development flags are honoured only by PHP's built-in server (Tools/DevRouter.php); on Apache they are ignored
// even if an environment variable with the same name were ever set
$env = [];
if (PHP_SAPI === 'cli-server') {
    foreach (['FIXTURE_MODE', 'DEV_BYPASS_AUTH', 'FIXTURE_DATA_PATH'] as $name) {
        $value = getenv($name);
        if ($value !== false) {
            $env[$name] = $value;
        }
    }
}

// Handle the request and send the response (HEAD sends headers only)
$app = new VaccinePortal\App(require __DIR__ . '/Private/Config.php', $env);
$request = VaccinePortal\Request::fromGlobals();
$app->handle($request)->send($request->method === 'HEAD');
