<?php

declare(strict_types=1);

namespace FleetDispatch;

/** 已驗證的請求者（對應 core/src/types.ts 的 Session）。 */
final class Session
{
    /**
     * @param string $deviceId 用戶端自己提供的裝置 ID（大寫）
     * @param string $identity 主機在這次配對時產生的身分；擁有權（建立的車趟、巡檢、用車申請）以它為準，
     *                         以同一個 deviceId 重新配對不會繼承之前的擁有權
     * @param string $role admin、driver 或 viewer（資料庫中不認得的角色視為 viewer）
     * @param array{driverUuid: string, driverName: string}|null $binding 綁定的駕駛人（只有駕駛有）
     */
    public function __construct(
        public readonly string $deviceId,
        public readonly string $identity,
        public readonly string $deviceName,
        public readonly string $role,
        public readonly ?array $binding,
        public readonly int $tokenExpiresAt,
    ) {
    }
}
