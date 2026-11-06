<?php

declare(strict_types=1);

// FleetDispatch Server（PHP 版）：載入全部類別（不需要 Composer）。
// 規格見 docs/protocol.md；行為與 core/src（TypeScript 參考實作）一致。

require_once __DIR__ . '/Version.php';
require_once __DIR__ . '/ApiError.php';
require_once __DIR__ . '/Util.php';
require_once __DIR__ . '/RawJson.php';
require_once __DIR__ . '/Json.php';
require_once __DIR__ . '/Crypto.php';
require_once __DIR__ . '/Session.php';
require_once __DIR__ . '/Rules.php';
require_once __DIR__ . '/Config.php';
require_once __DIR__ . '/Db.php';
require_once __DIR__ . '/Repo.php';
require_once __DIR__ . '/Request.php';
require_once __DIR__ . '/Response.php';
require_once __DIR__ . '/WebSession.php';
require_once __DIR__ . '/Web.php';
require_once __DIR__ . '/Installer.php';
require_once __DIR__ . '/AdminSpec.php';
require_once __DIR__ . '/Admin.php';
require_once __DIR__ . '/Reports.php';
require_once __DIR__ . '/AdminApi.php';
require_once __DIR__ . '/Api.php';
require_once __DIR__ . '/App.php';
