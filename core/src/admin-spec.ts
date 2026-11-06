// 由 scripts/build-web.mjs 從 spec/admin-entities.json 產生，請不要直接修改；修改原始檔後執行 npm run build:web。

import type { AdminSpec } from './admin.ts';

export const ADMIN_SPEC: AdminSpec = {
  "version": 1,
  "entities": {
    "trip": {
      "label": "車趟",
      "time": "startTime",
      "title": [
        "vehiclePlateNumber",
        "driver"
      ],
      "search": [
        "vehiclePlateNumber",
        "driver",
        "origin",
        "destinations",
        "mission",
        "costCenter"
      ],
      "sorts": {
        "time": {
          "label": "出車時間",
          "field": "startTime"
        },
        "end": {
          "label": "回車時間",
          "field": "endTime"
        },
        "modified": {
          "label": "最近修改",
          "field": "lastModifiedAt"
        },
        "plate": {
          "label": "車牌",
          "field": "vehiclePlateNumber"
        },
        "driver": {
          "label": "駕駛",
          "field": "driver"
        },
        "distance": {
          "label": "里程",
          "computed": "distance"
        },
        "cost": {
          "label": "費用",
          "computed": "cost"
        }
      },
      "defaultSort": "time",
      "defaultOrder": "desc",
      "statuses": {
        "active": "出車中",
        "completed": "已回車"
      },
      "fields": [
        {
          "key": "vehiclePlateNumber",
          "label": "車牌",
          "type": "plate",
          "edit": true
        },
        {
          "key": "driverEntityUUID",
          "label": "駕駛人",
          "type": "driverRef",
          "edit": true
        },
        {
          "key": "driver",
          "label": "駕駛（姓名）",
          "type": "text"
        },
        {
          "key": "isCompleted",
          "label": "狀態",
          "type": "bool",
          "edit": true
        },
        {
          "key": "startTime",
          "label": "出車時間",
          "type": "time",
          "edit": true
        },
        {
          "key": "endTime",
          "label": "回車時間",
          "type": "time",
          "edit": true
        },
        {
          "key": "odometerStart",
          "label": "起始里程",
          "type": "number",
          "unit": "km",
          "min": 0,
          "max": 10000000,
          "edit": true
        },
        {
          "key": "odometerEnd",
          "label": "結束里程",
          "type": "number",
          "unit": "km",
          "min": 0,
          "max": 10000000,
          "edit": true
        },
        {
          "key": "origin",
          "label": "起點",
          "type": "text",
          "max": 200,
          "edit": true
        },
        {
          "key": "destinations",
          "label": "目的地與停靠點",
          "type": "list",
          "max": 200,
          "maxItems": 20,
          "edit": true
        },
        {
          "key": "mission",
          "label": "任務內容",
          "type": "multiline",
          "max": 1000,
          "edit": true
        },
        {
          "key": "fuelType",
          "label": "油種",
          "type": "enum",
          "values": [
            [
              "",
              "未指定"
            ],
            [
              "汽油",
              "汽油"
            ],
            [
              "柴油",
              "柴油"
            ]
          ],
          "edit": true
        },
        {
          "key": "fuelAmount",
          "label": "加油／充電量",
          "type": "number",
          "unit": "L／kWh",
          "min": 0,
          "max": 100000,
          "edit": true
        },
        {
          "key": "fuelCost",
          "label": "油資／電費",
          "type": "number",
          "unit": "元",
          "min": 0,
          "max": 100000000,
          "edit": true
        },
        {
          "key": "tollCost",
          "label": "過路費",
          "type": "number",
          "unit": "元",
          "min": 0,
          "max": 100000000,
          "edit": true
        },
        {
          "key": "parkingCost",
          "label": "停車費",
          "type": "number",
          "unit": "元",
          "min": 0,
          "max": 100000000,
          "edit": true
        },
        {
          "key": "didSwapBattery",
          "label": "換電",
          "type": "bool",
          "edit": true
        },
        {
          "key": "costCenter",
          "label": "成本中心",
          "type": "text",
          "max": 100,
          "edit": true
        },
        {
          "key": "departureLocationStatus",
          "label": "出發定位",
          "type": "enum",
          "values": [
            [
              "confirmed",
              "出車時取得"
            ],
            [
              "late",
              "出車後第一個定位點"
            ],
            [
              "unavailable",
              "出車時無法取得"
            ]
          ]
        },
        {
          "key": "departureLatitude",
          "label": "出發緯度",
          "type": "number"
        },
        {
          "key": "departureLongitude",
          "label": "出發經度",
          "type": "number"
        },
        {
          "key": "departureHorizontalAccuracy",
          "label": "出發定位精度",
          "type": "number",
          "unit": "m"
        },
        {
          "key": "departureLocationTime",
          "label": "出發定位時間",
          "type": "time"
        },
        {
          "key": "lastModifiedAt",
          "label": "最近修改",
          "type": "time"
        }
      ]
    },
    "vehicle": {
      "label": "車輛",
      "time": null,
      "title": [
        "plateNumber",
        "brand"
      ],
      "search": [
        "plateNumber",
        "brand",
        "custodian",
        "vin"
      ],
      "sorts": {
        "plate": {
          "label": "車牌",
          "field": "plateNumber"
        },
        "brand": {
          "label": "廠牌",
          "field": "brand"
        },
        "year": {
          "label": "年份",
          "field": "modelYear"
        },
        "modified": {
          "label": "最近修改",
          "field": "lastModifiedAt"
        }
      },
      "defaultSort": "plate",
      "defaultOrder": "asc",
      "statuses": {},
      "fields": [
        {
          "key": "plateNumber",
          "label": "車牌",
          "type": "text"
        },
        {
          "key": "vehicleType",
          "label": "車種",
          "type": "enum",
          "values": [
            [
              "car",
              "汽車"
            ],
            [
              "motorcycle",
              "機車"
            ]
          ],
          "edit": true
        },
        {
          "key": "fuelType",
          "label": "動力",
          "type": "enum",
          "values": [
            [
              "gas",
              "汽油"
            ],
            [
              "hybrid",
              "油電混合"
            ],
            [
              "electric",
              "電動"
            ]
          ],
          "edit": true
        },
        {
          "key": "isElectric",
          "label": "電動車",
          "type": "bool"
        },
        {
          "key": "brand",
          "label": "廠牌",
          "type": "text",
          "max": 100,
          "edit": true
        },
        {
          "key": "modelYear",
          "label": "年份",
          "type": "integer",
          "min": 0,
          "max": 2100,
          "edit": true,
          "hint": "0 表示未設定；其他值必須在 1900–2100"
        },
        {
          "key": "vin",
          "label": "車身號碼",
          "type": "text",
          "max": 50,
          "edit": true
        },
        {
          "key": "custodian",
          "label": "保管人",
          "type": "text",
          "max": 100,
          "edit": true
        },
        {
          "key": "inspectionDueDate",
          "label": "驗車到期",
          "type": "date",
          "nullable": true,
          "edit": true
        },
        {
          "key": "compulsoryInsuranceDueDate",
          "label": "強制險到期",
          "type": "date",
          "nullable": true,
          "edit": true
        },
        {
          "key": "commercialInsuranceDueDate",
          "label": "任意險到期",
          "type": "date",
          "nullable": true,
          "edit": true
        },
        {
          "key": "lastModifiedAt",
          "label": "最近修改",
          "type": "time"
        }
      ]
    },
    "driver": {
      "label": "駕駛人",
      "time": null,
      "title": [
        "name"
      ],
      "search": [
        "name",
        "phoneNumber",
        "licenseNumber",
        "notes"
      ],
      "sorts": {
        "name": {
          "label": "姓名",
          "field": "name"
        },
        "license": {
          "label": "駕照到期",
          "field": "licenseExpiryDate"
        },
        "modified": {
          "label": "最近修改",
          "field": "lastModifiedAt"
        }
      },
      "defaultSort": "name",
      "defaultOrder": "asc",
      "statuses": {},
      "fields": [
        {
          "key": "name",
          "label": "姓名",
          "type": "text"
        },
        {
          "key": "phoneNumber",
          "label": "電話",
          "type": "text",
          "max": 50,
          "edit": true,
          "pii": "partial"
        },
        {
          "key": "licenseNumber",
          "label": "駕照號碼",
          "type": "text",
          "max": 50,
          "edit": true,
          "pii": "partial"
        },
        {
          "key": "licenseExpiryDate",
          "label": "駕照到期",
          "type": "date",
          "nullable": true,
          "edit": true
        },
        {
          "key": "notes",
          "label": "備註",
          "type": "multiline",
          "max": 2000,
          "edit": true,
          "pii": "full"
        },
        {
          "key": "lastModifiedAt",
          "label": "最近修改",
          "type": "time"
        }
      ]
    },
    "tripRequest": {
      "label": "用車申請",
      "time": "plannedStartTime",
      "title": [
        "requestedBy",
        "vehiclePlateNumber"
      ],
      "search": [
        "requestedBy",
        "vehiclePlateNumber",
        "origin",
        "destinations",
        "mission",
        "approvedBy",
        "rejectionReason"
      ],
      "sorts": {
        "time": {
          "label": "預計出發",
          "field": "plannedStartTime"
        },
        "requested": {
          "label": "申請時間",
          "field": "requestedAt"
        },
        "status": {
          "label": "狀態",
          "field": "status"
        },
        "modified": {
          "label": "最近修改",
          "field": "lastModifiedAt"
        }
      },
      "defaultSort": "requested",
      "defaultOrder": "desc",
      "statuses": {
        "pending": "待簽核",
        "approved": "已核准",
        "rejected": "已退回",
        "cancelled": "已取消"
      },
      "fields": [
        {
          "key": "status",
          "label": "狀態",
          "type": "enum",
          "values": [
            [
              "pending",
              "待簽核"
            ],
            [
              "approved",
              "已核准"
            ],
            [
              "rejected",
              "已退回"
            ],
            [
              "cancelled",
              "已取消"
            ]
          ]
        },
        {
          "key": "requestedBy",
          "label": "申請人",
          "type": "text"
        },
        {
          "key": "requestedAt",
          "label": "申請時間",
          "type": "time"
        },
        {
          "key": "plannedStartTime",
          "label": "預計出發",
          "type": "time"
        },
        {
          "key": "plannedEndTime",
          "label": "預計回來",
          "type": "time"
        },
        {
          "key": "vehiclePlateNumber",
          "label": "車牌",
          "type": "plate"
        },
        {
          "key": "origin",
          "label": "起點",
          "type": "text"
        },
        {
          "key": "destinations",
          "label": "目的地",
          "type": "list"
        },
        {
          "key": "mission",
          "label": "任務內容",
          "type": "multiline"
        },
        {
          "key": "approvedBy",
          "label": "簽核人",
          "type": "text"
        },
        {
          "key": "approvedAt",
          "label": "簽核時間",
          "type": "time"
        },
        {
          "key": "rejectionReason",
          "label": "退回原因",
          "type": "multiline"
        },
        {
          "key": "resultingTripUUID",
          "label": "核准後的車趟",
          "type": "tripRef"
        },
        {
          "key": "requestedByDeviceID",
          "label": "申請的裝置",
          "type": "deviceRef"
        },
        {
          "key": "lastModifiedAt",
          "label": "最近修改",
          "type": "time"
        }
      ]
    },
    "maintenance": {
      "label": "保養紀錄",
      "time": "maintenanceDate",
      "title": [
        "vehiclePlateNumber"
      ],
      "search": [
        "vehiclePlateNumber",
        "notes"
      ],
      "sorts": {
        "time": {
          "label": "保養日期",
          "field": "maintenanceDate"
        },
        "plate": {
          "label": "車牌",
          "field": "vehiclePlateNumber"
        },
        "cost": {
          "label": "費用",
          "field": "cost"
        },
        "odometer": {
          "label": "里程",
          "field": "odometerReading"
        },
        "modified": {
          "label": "最近修改",
          "field": "lastModifiedAt"
        }
      },
      "defaultSort": "time",
      "defaultOrder": "desc",
      "statuses": {},
      "fields": [
        {
          "key": "vehiclePlateNumber",
          "label": "車牌",
          "type": "plate"
        },
        {
          "key": "maintenanceDate",
          "label": "保養日期",
          "type": "time",
          "edit": true
        },
        {
          "key": "odometerReading",
          "label": "保養時里程",
          "type": "number",
          "unit": "km",
          "min": 0,
          "max": 10000000,
          "edit": true
        },
        {
          "key": "intervalKm",
          "label": "保養間隔",
          "type": "number",
          "unit": "km",
          "min": 0,
          "max": 1000000,
          "edit": true
        },
        {
          "key": "cost",
          "label": "費用",
          "type": "number",
          "unit": "元",
          "min": 0,
          "max": 100000000,
          "edit": true
        },
        {
          "key": "notes",
          "label": "備註",
          "type": "multiline",
          "max": 2000,
          "edit": true
        },
        {
          "key": "createdAt",
          "label": "建立時間",
          "type": "time"
        },
        {
          "key": "lastModifiedAt",
          "label": "最近修改",
          "type": "time"
        }
      ]
    },
    "maintenanceItem": {
      "label": "保養項目",
      "time": "lastServiceDate",
      "title": [
        "name",
        "vehiclePlateNumber"
      ],
      "search": [
        "name",
        "vehiclePlateNumber",
        "notes"
      ],
      "sorts": {
        "name": {
          "label": "項目",
          "field": "name"
        },
        "plate": {
          "label": "車牌",
          "field": "vehiclePlateNumber"
        },
        "time": {
          "label": "上次保養",
          "field": "lastServiceDate"
        },
        "modified": {
          "label": "最近修改",
          "field": "lastModifiedAt"
        }
      },
      "defaultSort": "plate",
      "defaultOrder": "asc",
      "statuses": {},
      "fields": [
        {
          "key": "vehiclePlateNumber",
          "label": "車牌",
          "type": "plate"
        },
        {
          "key": "name",
          "label": "項目",
          "type": "text",
          "max": 100,
          "required": true,
          "edit": true
        },
        {
          "key": "intervalKm",
          "label": "間隔里程",
          "type": "number",
          "unit": "km",
          "min": 0,
          "max": 1000000,
          "edit": true
        },
        {
          "key": "intervalMonths",
          "label": "間隔月數",
          "type": "integer",
          "min": 0,
          "max": 240,
          "edit": true
        },
        {
          "key": "lastServiceOdometer",
          "label": "上次保養里程",
          "type": "number",
          "unit": "km",
          "min": 0,
          "max": 10000000,
          "edit": true
        },
        {
          "key": "lastServiceDate",
          "label": "上次保養日期",
          "type": "date",
          "nullable": true,
          "edit": true
        },
        {
          "key": "notes",
          "label": "備註",
          "type": "multiline",
          "max": 2000,
          "edit": true
        },
        {
          "key": "lastModifiedAt",
          "label": "最近修改",
          "type": "time"
        }
      ]
    },
    "part": {
      "label": "零件",
      "time": null,
      "title": [
        "name",
        "partNumber"
      ],
      "search": [
        "name",
        "partNumber",
        "category",
        "supplier",
        "notes"
      ],
      "sorts": {
        "name": {
          "label": "名稱",
          "field": "name"
        },
        "stock": {
          "label": "庫存",
          "field": "stockQuantity"
        },
        "cost": {
          "label": "單價",
          "field": "unitCost"
        },
        "modified": {
          "label": "最近修改",
          "field": "lastModifiedAt"
        }
      },
      "defaultSort": "name",
      "defaultOrder": "asc",
      "statuses": {
        "low": "低於安全庫存"
      },
      "fields": [
        {
          "key": "name",
          "label": "名稱",
          "type": "text",
          "max": 100,
          "required": true,
          "edit": true
        },
        {
          "key": "partNumber",
          "label": "料號",
          "type": "text",
          "max": 100,
          "edit": true
        },
        {
          "key": "category",
          "label": "分類",
          "type": "text",
          "max": 100,
          "edit": true
        },
        {
          "key": "unit",
          "label": "單位",
          "type": "text",
          "max": 20,
          "edit": true
        },
        {
          "key": "unitCost",
          "label": "單價",
          "type": "number",
          "unit": "元",
          "min": 0,
          "max": 100000000,
          "edit": true
        },
        {
          "key": "stockQuantity",
          "label": "庫存",
          "type": "number",
          "min": 0,
          "max": 100000000,
          "edit": true
        },
        {
          "key": "reorderThreshold",
          "label": "安全庫存",
          "type": "number",
          "min": 0,
          "max": 100000000,
          "edit": true
        },
        {
          "key": "supplier",
          "label": "供應商",
          "type": "text",
          "max": 100,
          "edit": true
        },
        {
          "key": "notes",
          "label": "備註",
          "type": "multiline",
          "max": 2000,
          "edit": true
        },
        {
          "key": "createdAt",
          "label": "建立時間",
          "type": "time"
        },
        {
          "key": "lastModifiedAt",
          "label": "最近修改",
          "type": "time"
        }
      ]
    },
    "workOrder": {
      "label": "工單",
      "time": "openedAt",
      "title": [
        "title",
        "vehiclePlateNumber"
      ],
      "search": [
        "title",
        "vehiclePlateNumber",
        "assignedTo",
        "notes"
      ],
      "sorts": {
        "time": {
          "label": "開單時間",
          "field": "openedAt"
        },
        "closed": {
          "label": "完工時間",
          "field": "closedAt"
        },
        "plate": {
          "label": "車牌",
          "field": "vehiclePlateNumber"
        },
        "status": {
          "label": "狀態",
          "field": "status"
        },
        "modified": {
          "label": "最近修改",
          "field": "lastModifiedAt"
        }
      },
      "defaultSort": "time",
      "defaultOrder": "desc",
      "statuses": {
        "open": "待處理",
        "inProgress": "進行中",
        "waitingParts": "待料",
        "completed": "已完成",
        "cancelled": "已取消"
      },
      "fields": [
        {
          "key": "vehiclePlateNumber",
          "label": "車牌",
          "type": "plate"
        },
        {
          "key": "title",
          "label": "標題",
          "type": "text",
          "max": 200,
          "required": true,
          "edit": true
        },
        {
          "key": "status",
          "label": "狀態",
          "type": "enum",
          "values": [
            [
              "open",
              "待處理"
            ],
            [
              "inProgress",
              "進行中"
            ],
            [
              "waitingParts",
              "待料"
            ],
            [
              "completed",
              "已完成"
            ],
            [
              "cancelled",
              "已取消"
            ]
          ],
          "edit": true,
          "hint": "完工請在 App 操作（會扣零件庫存並寫保養紀錄）"
        },
        {
          "key": "openedAt",
          "label": "開單時間",
          "type": "time"
        },
        {
          "key": "closedAt",
          "label": "完工時間",
          "type": "time"
        },
        {
          "key": "odometer",
          "label": "里程",
          "type": "number",
          "unit": "km",
          "min": 0,
          "max": 10000000,
          "edit": true
        },
        {
          "key": "assignedTo",
          "label": "負責人",
          "type": "text",
          "max": 100,
          "edit": true
        },
        {
          "key": "notes",
          "label": "備註",
          "type": "multiline",
          "max": 2000,
          "edit": true
        },
        {
          "key": "lines",
          "label": "明細",
          "type": "workOrderLines"
        },
        {
          "key": "createdAt",
          "label": "建立時間",
          "type": "time"
        },
        {
          "key": "lastModifiedAt",
          "label": "最近修改",
          "type": "time"
        }
      ]
    },
    "inspection": {
      "label": "巡檢",
      "time": "date",
      "title": [
        "vehiclePlateNumber",
        "driverName"
      ],
      "search": [
        "vehiclePlateNumber",
        "driverName",
        "notes"
      ],
      "sorts": {
        "time": {
          "label": "巡檢時間",
          "field": "date"
        },
        "plate": {
          "label": "車牌",
          "field": "vehiclePlateNumber"
        },
        "driver": {
          "label": "駕駛",
          "field": "driverName"
        },
        "result": {
          "label": "結果",
          "field": "overallResult"
        },
        "modified": {
          "label": "最近修改",
          "field": "lastModifiedAt"
        }
      },
      "defaultSort": "time",
      "defaultOrder": "desc",
      "statuses": {
        "pass": "合格",
        "fail": "有缺陷"
      },
      "fields": [
        {
          "key": "vehiclePlateNumber",
          "label": "車牌",
          "type": "plate"
        },
        {
          "key": "type",
          "label": "類型",
          "type": "enum",
          "values": [
            [
              "preTrip",
              "出車前"
            ],
            [
              "postTrip",
              "收車後"
            ]
          ],
          "edit": true
        },
        {
          "key": "date",
          "label": "巡檢時間",
          "type": "time"
        },
        {
          "key": "driverName",
          "label": "駕駛",
          "type": "text"
        },
        {
          "key": "overallResult",
          "label": "結果",
          "type": "enum",
          "values": [
            [
              "pass",
              "合格"
            ],
            [
              "fail",
              "有缺陷"
            ]
          ],
          "hint": "由明細自動判斷"
        },
        {
          "key": "odometer",
          "label": "里程",
          "type": "number",
          "unit": "km",
          "min": 0,
          "max": 10000000,
          "edit": true
        },
        {
          "key": "notes",
          "label": "備註",
          "type": "multiline",
          "max": 2000,
          "edit": true
        },
        {
          "key": "lines",
          "label": "明細",
          "type": "inspectionLines"
        },
        {
          "key": "createdAt",
          "label": "建立時間",
          "type": "time"
        },
        {
          "key": "lastModifiedAt",
          "label": "最近修改",
          "type": "time"
        }
      ]
    },
    "preset": {
      "label": "派車預設值",
      "time": null,
      "title": [
        "companyName"
      ],
      "search": [
        "companyName",
        "defaultOrigin",
        "defaultMission",
        "defaultDriver"
      ],
      "sorts": {
        "modified": {
          "label": "最近修改",
          "field": "lastModifiedAt"
        }
      },
      "defaultSort": "modified",
      "defaultOrder": "desc",
      "statuses": {},
      "fields": [
        {
          "key": "companyName",
          "label": "公司名稱",
          "type": "text",
          "max": 100,
          "edit": true
        },
        {
          "key": "defaultOrigin",
          "label": "預設起點",
          "type": "text",
          "max": 200,
          "edit": true
        },
        {
          "key": "defaultDestinations",
          "label": "預設目的地",
          "type": "list",
          "max": 200,
          "maxItems": 20,
          "edit": true
        },
        {
          "key": "defaultMission",
          "label": "預設任務",
          "type": "multiline",
          "max": 1000,
          "edit": true
        },
        {
          "key": "defaultDriver",
          "label": "預設駕駛",
          "type": "text",
          "max": 100,
          "edit": true
        },
        {
          "key": "logoData",
          "label": "標誌",
          "type": "image"
        },
        {
          "key": "lastModifiedAt",
          "label": "最近修改",
          "type": "time"
        }
      ]
    }
  },
  "reasons": [
    "更正輸入錯誤",
    "補登資料",
    "依駕駛回報修正",
    "依單據修正"
  ]
};
