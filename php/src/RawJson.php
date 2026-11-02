<?php

declare(strict_types=1);

namespace FleetDispatch;

/** 已經是 JSON 的片段（例如主機原樣保存的資料內容），回應時直接嵌入，不再解碼與編碼。 */
final class RawJson
{
    public function __construct(public readonly string $json)
    {
    }
}
