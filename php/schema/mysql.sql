-- FleetDispatch Server（PHP 版）資料庫結構：MySQL 8.0 以上／MariaDB 10.6 以上（InnoDB、utf8mb4）。
-- 主機第一次收到 API 請求時會自動建立（CREATE TABLE IF NOT EXISTS），通常不需要手動匯入。
-- 只有資料庫帳號沒有建立資料表的權限時，才需要先用 phpMyAdmin 或 mysql 指令匯入這個檔案。
--
-- 資料表與欄位和 SQLite 版（schema/sqlite.sql）相同，另外：
-- 文字欄位使用 utf8mb4_bin（區分大小寫、逐字元比對），與 SQLite 的比對方式一致。
-- 數值欄位：毫秒時間與序號用 BIGINT，Apple 秒與座標用 DOUBLE（不可用 FLOAT，精度不夠）。
-- fd_attempts 多一個自動編號的主鍵（有些主機要求每個資料表都要有主鍵）。
-- fd_devices.identity 是主機在每次配對時產生的身分，fd_records.created_by 記錄建立那筆資料的身分。
-- 注意：這個檔案由程式以分號切開執行，註解只能寫成整行的 -- 註解，而且註解裡不能有分號。

CREATE TABLE IF NOT EXISTS fd_meta (
    k VARCHAR(64) NOT NULL,
    v TEXT NOT NULL,
    PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS fd_records (
    entity VARCHAR(32) NOT NULL,
    id VARCHAR(36) NOT NULL,
    seq BIGINT NOT NULL,
    modified_at DOUBLE NOT NULL,
    deleted TINYINT NOT NULL DEFAULT 0,
    payload LONGTEXT NULL,
    driver_uuid TEXT NULL,
    driver_name TEXT NULL,
    requester_device TEXT NULL,
    vehicle_plate TEXT NULL,
    created_by VARCHAR(36) NULL,
    updated_by VARCHAR(36) NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (entity, id),
    UNIQUE KEY fd_records_seq (seq),
    KEY fd_records_plate (vehicle_plate(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS fd_devices (
    device_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    platform VARCHAR(64) NOT NULL DEFAULT '',
    role VARCHAR(16) NOT NULL,
    driver_uuid VARCHAR(36) NULL,
    driver_name VARCHAR(255) NULL,
    token_hash VARCHAR(64) NULL,
    token_expires_at BIGINT NULL,
    paired_at BIGINT NOT NULL,
    last_seen_at BIGINT NULL,
    revoked_at BIGINT NULL,
    identity VARCHAR(36) NULL,
    PRIMARY KEY (device_id),
    UNIQUE KEY fd_devices_token (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS fd_pairing_codes (
    id VARCHAR(36) NOT NULL,
    code_hash VARCHAR(64) NOT NULL,
    role VARCHAR(16) NOT NULL,
    driver_uuid VARCHAR(36) NULL,
    driver_name VARCHAR(255) NULL,
    label VARCHAR(255) NOT NULL DEFAULT '',
    created_by VARCHAR(36) NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at BIGINT NULL,
    used_by VARCHAR(36) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY fd_pairing_codes_hash (code_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS fd_audit (
    id BIGINT NOT NULL AUTO_INCREMENT,
    at BIGINT NOT NULL,
    device_id VARCHAR(36) NOT NULL,
    device_name VARCHAR(255) NOT NULL,
    entity VARCHAR(32) NOT NULL,
    entity_id VARCHAR(36) NOT NULL,
    operation VARCHAR(16) NOT NULL,
    summary TEXT NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS fd_locations (
    trip_id VARCHAR(36) NOT NULL,
    device_id VARCHAR(36) NOT NULL,
    device_name VARCHAR(255) NOT NULL,
    plate TEXT NULL,
    latitude DOUBLE NOT NULL,
    longitude DOUBLE NOT NULL,
    speed DOUBLE NULL,
    course DOUBLE NULL,
    ts DOUBLE NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (trip_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS fd_attempts (
    id BIGINT NOT NULL AUTO_INCREMENT,
    ip VARCHAR(64) NOT NULL,
    at BIGINT NOT NULL,
    PRIMARY KEY (id),
    KEY fd_attempts_ip (ip, at),
    KEY fd_attempts_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
