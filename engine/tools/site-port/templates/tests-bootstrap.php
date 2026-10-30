<?php

/**
 * This site's vendor/ is pre-committed without dev dependencies, and there is
 * no Composer in these containers, so vendor/composer/autoload_psr4.php never
 * got the "Tests\\" => "tests/" mapping composer.json's autoload-dev
 * declares. Every test in this suite -- including the stock ExampleTest.php
 * that ships with the site -- is unrunnable without it. Registered here
 * instead of hand-editing the generated vendor/composer/*.php files, which
 * Composer would be free to overwrite the moment it *can* run again.
 */

require __DIR__ . '/../vendor/autoload.php';

spl_autoload_register(function ($class) {
    $prefix = 'Tests\\';

    if (strncmp($prefix, $class, strlen($prefix)) !== 0) {
        return;
    }

    $relative = substr($class, strlen($prefix));
    $path = __DIR__ . '/' . str_replace('\\', '/', $relative) . '.php';

    if (is_file($path)) {
        require $path;
    }
});
