-- =============================================================================
-- 数据库迁移脚本：创建 user_entitlements 表并回填数据
-- =============================================================================
-- 作用：创建用户权益表，并从现有 orders/users 数据回填初始权益状态
-- 用法：mysql -u root -p ip_proxy_platform < migrate_add_user_entitlements.sql
-- 注意：执行前请备份数据库
-- =============================================================================

USE ip_proxy_platform;

-- 创建 user_entitlements 表
CREATE TABLE IF NOT EXISTS `user_entitlements` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `group_id` INT NOT NULL COMMENT '总套餐ID（外键 plan_groups.id）',
  `plan_id` INT NOT NULL COMMENT '子套餐ID（外键 plans.id，用于节点权限 plan_nodes）',
  `status` ENUM('active','cancelled','expired','exhausted') NOT NULL DEFAULT 'active' COMMENT '状态：active=有效,cancelled=已取消,expired=已过期,exhausted=流量耗尽',
  `original_started_at` DATETIME NOT NULL COMMENT '原始开始时间（购买时的 paid_at）',
  `original_expire_at` DATETIME NOT NULL COMMENT '原始到期时间（购买时计算的到期时间，不退订时与 service_expire_at 相同）',
  `service_started_at` DATETIME NOT NULL COMMENT '实际服务开始时间（初始与 original_started_at 相同，部分退订可能调整）',
  `service_expire_at` DATETIME NOT NULL COMMENT '实际服务到期时间（部分退订扣减天数时只改此字段，不动 original_expire_at）',
  `traffic_total_bytes` BIGINT NOT NULL DEFAULT 0 COMMENT '该权益的流量配额（字节，0=无流量）',
  `traffic_used_bytes` BIGINT NOT NULL DEFAULT 0 COMMENT '该权益已用流量（字节）',
  `last_order_id` INT DEFAULT NULL COMMENT '最近一次影响该权益的订单ID（便于追溯）',
  `cancel_reason` VARCHAR(255) DEFAULT NULL COMMENT '取消原因（如：全额退订、手动取消）',
  `cancelled_at` DATETIME DEFAULT NULL COMMENT '取消时间',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_user_status` (`user_id`, `status`),
  KEY `idx_user_group_status` (`user_id`, `group_id`, `status`),
  KEY `idx_user_plan_status` (`user_id`, `plan_id`, `status`),
  KEY `idx_service_expire_at` (`service_expire_at`),
  KEY `idx_last_order_id` (`last_order_id`),
  CONSTRAINT `fk_entitlements_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_entitlements_group` FOREIGN KEY (`group_id`) REFERENCES `plan_groups` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_entitlements_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_entitlements_order` FOREIGN KEY (`last_order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户权益表（权威状态：当前套餐/到期/流量）';

-- =============================================================================
-- 回填数据：从 orders 表生成初始权益
-- =============================================================================
-- 策略：
-- 1. 按用户+group_id 分组，汇总所有已支付订单（含退订负单）
-- 2. 计算每个 group 的累计天数、累计流量、最早 paid_at、最晚到期时间
-- 3. 如果累计天数<=0 或已过期，标记为 cancelled/expired
-- 4. traffic_used_bytes 从 users.traffic_used 按"最早到期优先"分摊
-- =============================================================================

INSERT INTO `user_entitlements` (
  `user_id`, `group_id`, `plan_id`, `status`,
  `original_started_at`, `original_expire_at`, `service_started_at`, `service_expire_at`,
  `traffic_total_bytes`, `traffic_used_bytes`, `last_order_id`, `created_at`
)
SELECT 
  o.user_id,
  p.group_id,
  o.plan_id,
  CASE
    -- 如果累计天数<=0，标记为 cancelled
    WHEN SUM(o.duration_days) <= 0 THEN 'cancelled'
    -- 如果已过期，标记为 expired
    WHEN DATE_ADD(MIN(o.paid_at), INTERVAL SUM(o.duration_days) DAY) <= NOW() THEN 'expired'
    -- 否则为 active
    ELSE 'active'
  END AS status,
  MIN(o.paid_at) AS original_started_at,
  DATE_ADD(MIN(o.paid_at), INTERVAL SUM(o.duration_days) DAY) AS original_expire_at,
  MIN(o.paid_at) AS service_started_at,
  DATE_ADD(MIN(o.paid_at), INTERVAL SUM(o.duration_days) DAY) AS service_expire_at,
  GREATEST(0, SUM(o.traffic_amount)) AS traffic_total_bytes,
  0 AS traffic_used_bytes, -- 先设为0，后续按策略分摊
  MAX(o.id) AS last_order_id, -- 取最新的订单ID
  MIN(o.created_at) AS created_at
FROM orders o
JOIN plans p ON o.plan_id = p.id
WHERE o.status = 'paid' AND o.paid_at IS NOT NULL
GROUP BY o.user_id, p.group_id, o.plan_id
HAVING SUM(o.duration_days) > 0; -- 只回填有正数天数的权益

-- =============================================================================
-- 分摊 traffic_used_bytes：按"最早到期优先"策略
-- =============================================================================
-- 对于每个用户，将其 users.traffic_used 按最早到期的 active 权益优先分摊
-- =============================================================================

-- 创建临时表存储用户总已用流量
CREATE TEMPORARY TABLE IF NOT EXISTS temp_user_traffic AS
SELECT user_id, traffic_used FROM users WHERE traffic_used > 0;

-- 按用户和到期时间排序，分摊流量
UPDATE user_entitlements e
JOIN (
  SELECT 
    e1.id,
    e1.user_id,
    e1.traffic_total_bytes,
    e1.service_expire_at,
    COALESCE(SUM(e2.traffic_total_bytes), 0) AS prior_total_bytes,
    COALESCE(SUM(e2.traffic_used_bytes), 0) AS prior_used_bytes
  FROM user_entitlements e1
  LEFT JOIN user_entitlements e2 ON e1.user_id = e2.user_id 
    AND e2.status = 'active' 
    AND e2.service_expire_at < e1.service_expire_at
  WHERE e1.status = 'active'
  GROUP BY e1.id, e1.user_id, e1.traffic_total_bytes, e1.service_expire_at
) ranked ON e.id = ranked.id
JOIN temp_user_traffic ut ON e.user_id = ut.user_id
SET e.traffic_used_bytes = GREATEST(0, LEAST(
  e.traffic_total_bytes,
  GREATEST(0, ut.traffic_used - ranked.prior_used_bytes)
))
WHERE e.status = 'active' AND e.traffic_total_bytes > 0;

-- 更新 exhausted 状态：如果已用流量 >= 总流量配额
UPDATE user_entitlements
SET status = 'exhausted'
WHERE status = 'active' 
  AND traffic_total_bytes > 0 
  AND traffic_used_bytes >= traffic_total_bytes;

-- 更新 expired 状态：如果 service_expire_at <= NOW()
UPDATE user_entitlements
SET status = 'expired'
WHERE status = 'active' 
  AND service_expire_at <= NOW();

DROP TEMPORARY TABLE IF EXISTS temp_user_traffic;

-- =============================================================================
-- 迁移完成提示
-- =============================================================================
SELECT 
  'Migration completed' AS message,
  COUNT(*) AS total_entitlements,
  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
  SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
  SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired_count,
  SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END) AS exhausted_count
FROM user_entitlements;
