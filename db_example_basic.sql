-- =============================================================================
-- 数据库初始化脚本：ip_proxy_platform（由当前库反向生成，供 Docker + 后端完整运行）
-- =============================================================================
-- 作用：创建库 + 全部表 + 示例套餐与节点
-- 用法：在 MySQL 中执行本文件 entire 内容，或 SOURCE 本文件路径
-- 注意：会 DROP 已存在的同名表，再 CREATE，适合空库或需要重建时使用
-- =============================================================================

CREATE DATABASE IF NOT EXISTS ip_proxy_platform
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE ip_proxy_platform;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
-- DROP 顺序：先删子表/依赖表
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `node_connections`;
DROP TABLE IF EXISTS `node_traffic`;
DROP TABLE IF EXISTS `plan_nodes`;
DROP TABLE IF EXISTS `ticket_replies`;
DROP TABLE IF EXISTS `tickets`;
DROP TABLE IF EXISTS `user_entitlements`;
DROP TABLE IF EXISTS `orders`;
DROP TABLE IF EXISTS `subscriptions`;
DROP TABLE IF EXISTS `user_clients`;
DROP TABLE IF EXISTS `user_signins`;
DROP TABLE IF EXISTS `user_traffic_minute`;
DROP TABLE IF EXISTS `plans`;
DROP TABLE IF EXISTS `nodes`;
DROP TABLE IF EXISTS `plan_groups`;
DROP TABLE IF EXISTS `system_settings`;
DROP TABLE IF EXISTS `users`;

-- -----------------------------------------------------------------------------
-- 1. 用户表 users（auth 注册/登录；admin 用户管理）
-- -----------------------------------------------------------------------------
CREATE TABLE `users` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `email` VARCHAR(100) NOT NULL COMMENT '邮箱（登录/通知）',
  `username` VARCHAR(50) NOT NULL COMMENT '用户名（登录显示名）',
  `password_hash` VARCHAR(255) NOT NULL COMMENT '密码哈希（bcrypt）',
  `invite_code` VARCHAR(32) DEFAULT NULL COMMENT '自身邀请码（预留）',
  `invited_by` INT DEFAULT NULL COMMENT '邀请人用户ID（预留）',
  `balance` DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '账户余额',
  `traffic_total` BIGINT NOT NULL DEFAULT 0 COMMENT '总流量配额（字节）',
  `traffic_used` BIGINT NOT NULL DEFAULT 0 COMMENT '已用流量（字节）',
  `status` ENUM('active','banned') NOT NULL DEFAULT 'active' COMMENT '状态：active=正常,banned=封禁',
  `role` ENUM('user','admin') NOT NULL DEFAULT 'user' COMMENT '角色：user=普通用户,admin=管理员',
  `expired_at` DATETIME DEFAULT NULL COMMENT '账户/订阅到期时间（预留）',
  `last_login_ip` VARCHAR(45) DEFAULT NULL COMMENT '最后登录 IP',
  `last_login_at` DATETIME DEFAULT NULL COMMENT '最后登录时间',
  `last_signin_at` DATETIME DEFAULT NULL COMMENT '最后一次签到时间',
  `signin_streak` INT NOT NULL DEFAULT 0 COMMENT '连续签到天数',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  UNIQUE KEY `username` (`username`),
  KEY `idx_status` (`status`),
  KEY `idx_invited_by` (`invited_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表';

-- -----------------------------------------------------------------------------
-- 2.1 总套餐表 plan_groups（反向自库）
-- -----------------------------------------------------------------------------
CREATE TABLE `plan_groups` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `group_key` VARCHAR(100) NOT NULL COMMENT '总套餐唯一标识（例如 basic/pro/vip）',
  `name` VARCHAR(100) NOT NULL COMMENT '总套餐名称（例如 基础套餐、高级套餐）',
  `level` INT NOT NULL DEFAULT 0 COMMENT '等级/优先级（越大可用节点越多）',
  `is_exclusive` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否互斥：1=互斥,0=可共存',
  `status` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '状态：1=启用,0=停用',
  `is_public` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否在套餐列表展示：1=展示,0=不展示',
  `sort_order` INT NOT NULL DEFAULT 0 COMMENT '排序顺序',
  `connections` INT NOT NULL DEFAULT 1 COMMENT '共享设备数（该总套餐下所有子套餐共用）',
  `speed_limit` INT NOT NULL DEFAULT 0 COMMENT '限速 Mbps，0=不限（该总套餐下所有子套餐共用）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `group_key` (`group_key`),
  KEY `idx_status` (`status`),
  KEY `idx_level` (`level`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='总套餐表';

-- -----------------------------------------------------------------------------
-- 2.2 子套餐表 plans（/api/plans、/api/orders、admin 套餐管理）
-- -----------------------------------------------------------------------------
CREATE TABLE `plans` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `group_id` INT NOT NULL COMMENT '所属总套餐ID（外键 plan_groups.id）',
  `name` VARCHAR(100) NOT NULL COMMENT '子套餐名称（例如 基础套餐-月）',
  `description` TEXT DEFAULT NULL COMMENT '套餐说明',
  `price` DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '套餐价格',
  `duration_days` INT NOT NULL DEFAULT 30 COMMENT '套餐持续时间（天）',
  `traffic_limit` BIGINT NOT NULL DEFAULT 0 COMMENT '总流量配额（字节，0=不限）',
  `speed_limit` INT NOT NULL DEFAULT 0 COMMENT '限速（Mbps，0=不限速）',
  `connections` INT NOT NULL DEFAULT 1 COMMENT '同时在线设备数',
  `is_public` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否上架/公开',
  `status` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '状态：1=启用,0=停用',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_plans_group` FOREIGN KEY (`group_id`) REFERENCES `plan_groups` (`id`) ON DELETE RESTRICT,
  KEY `idx_status` (`status`),
  KEY `idx_is_public` (`is_public`),
  KEY `idx_group_id` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='子套餐表';

-- -----------------------------------------------------------------------------
-- 2.3 节点表 nodes（反向自库）
-- -----------------------------------------------------------------------------
CREATE TABLE `nodes` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `name` VARCHAR(100) NOT NULL COMMENT '节点名称',
  `address` VARCHAR(100) NOT NULL COMMENT '节点地址',
  `port` INT NOT NULL COMMENT '端口',
  `protocol` ENUM('vmess','vless','trojan','shadowsocks','hysteria2','socks','http','wireguard') NOT NULL COMMENT '协议',
  `config` TEXT NOT NULL COMMENT '协议配置（JSON 文本）',
  `status` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '状态：1=启用,0=停用',
  `sort_order` INT NOT NULL DEFAULT 0 COMMENT '排序',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='节点表';

-- -----------------------------------------------------------------------------
-- 2.4 套餐-节点关联表 plan_nodes（反向自库）
-- -----------------------------------------------------------------------------
CREATE TABLE `plan_nodes` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `plan_id` INT NOT NULL COMMENT '套餐ID',
  `node_id` INT NOT NULL COMMENT '节点ID',
  `priority` INT NOT NULL DEFAULT 0 COMMENT '优先级/排序',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  KEY `idx_plan_id` (`plan_id`),
  KEY `idx_node_id` (`node_id`),
  CONSTRAINT `fk_plan_nodes_node` FOREIGN KEY (`node_id`) REFERENCES `nodes` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_plan_nodes_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='套餐与节点多对多关联';

-- -----------------------------------------------------------------------------
-- 3. 订单表 orders（/api/orders、admin 订单管理）
-- -----------------------------------------------------------------------------
CREATE TABLE `orders` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `plan_id` INT NOT NULL COMMENT '套餐ID',
  `order_no` VARCHAR(64) NOT NULL COMMENT '订单号',
  `trade_no` VARCHAR(128) DEFAULT NULL COMMENT '第三方支付单号（预留）',
  `amount` DECIMAL(10,2) NOT NULL COMMENT '订单金额',
  `pay_method` ENUM('balance','alipay','wechat','crypto') NOT NULL DEFAULT 'balance' COMMENT '支付方式',
  `status` ENUM('pending','paid','cancelled','expired') NOT NULL DEFAULT 'pending' COMMENT '订单状态',
  `order_type` VARCHAR(20) NOT NULL DEFAULT 'purchase' COMMENT 'purchase=购买, unsubscribe=管理员退订',
  `duration_days` INT NOT NULL COMMENT '本订单有效期（天）；退订时为扣减天数',
  `traffic_amount` BIGINT NOT NULL DEFAULT 0 COMMENT '本单流量(字节)：购买为赠送量，退订为扣减量',
  `remark` VARCHAR(255) DEFAULT NULL COMMENT '备注，如：管理员退订',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `paid_at` DATETIME DEFAULT NULL COMMENT '支付时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `order_no` (`order_no`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_status` (`status`),
  CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_orders_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单表';

-- -----------------------------------------------------------------------------
-- 3.1 用户权益表 user_entitlements（权威状态：当前套餐/到期/流量）
-- -----------------------------------------------------------------------------
CREATE TABLE `user_entitlements` (
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

-- -----------------------------------------------------------------------------
-- 4. 工单表 tickets（/api/tickets、admin 工单管理）
-- -----------------------------------------------------------------------------
CREATE TABLE `tickets` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `ticket_no` VARCHAR(64) NOT NULL COMMENT '工单号',
  `title` VARCHAR(200) NOT NULL COMMENT '标题',
  `content` TEXT NOT NULL COMMENT '内容',
  `category` ENUM('technical','billing','account','other') NOT NULL DEFAULT 'other' COMMENT '分类',
  `status` ENUM('open','in_progress','resolved','closed') NOT NULL DEFAULT 'open' COMMENT '状态',
  `priority` ENUM('low','medium','high','urgent') NOT NULL DEFAULT 'medium' COMMENT '优先级',
  `admin_id` INT DEFAULT NULL COMMENT '处理管理员ID',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `resolved_at` DATETIME DEFAULT NULL COMMENT '解决时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `ticket_no` (`ticket_no`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_status` (`status`),
  CONSTRAINT `fk_tickets_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='工单表';

-- -----------------------------------------------------------------------------
-- 4.1 工单回复表 ticket_replies（/api/tickets、admin 工单回复）
-- -----------------------------------------------------------------------------
CREATE TABLE `ticket_replies` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `ticket_id` INT NOT NULL COMMENT '工单ID',
  `user_id` INT NOT NULL COMMENT '回复人用户ID',
  `is_admin` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否管理员回复：1=是,0=用户',
  `content` TEXT NOT NULL COMMENT '回复内容',
  `attachments` TEXT DEFAULT NULL COMMENT '附件（JSON 或逗号分隔 URL，预留）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  KEY `idx_ticket_id` (`ticket_id`),
  CONSTRAINT `fk_ticket_replies_ticket` FOREIGN KEY (`ticket_id`) REFERENCES `tickets` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ticket_replies_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='工单回复表';

-- -----------------------------------------------------------------------------
-- 5. 用户客户端/UUID 表 user_clients（反向自库，internal/subscription 用）
-- -----------------------------------------------------------------------------
CREATE TABLE `user_clients` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `uuid` CHAR(36) NOT NULL COMMENT '客户端唯一标识（如 VLESS/VMess UUID）',
  `remark` VARCHAR(100) DEFAULT NULL COMMENT '备注（如 默认设备）',
  `enabled` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用：1=是,0=否',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_clients_uuid` (`uuid`),
  KEY `idx_user_id` (`user_id`),
  CONSTRAINT `fk_user_clients_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户客户端/UUID 表';

-- -----------------------------------------------------------------------------
-- 6. 节点连接记录 node_connections（反向自库）
-- -----------------------------------------------------------------------------
CREATE TABLE `node_connections` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `node_id` INT NOT NULL COMMENT '节点ID',
  `ip` VARCHAR(45) NOT NULL COMMENT '连接 IP',
  `start_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '连接开始时间',
  `end_time` DATETIME DEFAULT NULL COMMENT '连接结束时间',
  `upload` BIGINT NOT NULL DEFAULT 0 COMMENT '该连接上传（字节）',
  `download` BIGINT NOT NULL DEFAULT 0 COMMENT '该连接下载（字节）',
  `status` ENUM('active','closed') NOT NULL DEFAULT 'active' COMMENT '状态',
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_node_id` (`node_id`),
  KEY `idx_status` (`status`),
  CONSTRAINT `fk_nc_node` FOREIGN KEY (`node_id`) REFERENCES `nodes` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_nc_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='节点连接记录';

-- -----------------------------------------------------------------------------
-- 7. 节点流量统计 node_traffic（反向自库）
-- -----------------------------------------------------------------------------
CREATE TABLE `node_traffic` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `node_id` INT NOT NULL COMMENT '节点ID',
  `date` DATE NOT NULL COMMENT '统计日期',
  `upload` BIGINT NOT NULL DEFAULT 0 COMMENT '当日上传（字节）',
  `download` BIGINT NOT NULL DEFAULT 0 COMMENT '当日下载（字节）',
  `connections` INT NOT NULL DEFAULT 0 COMMENT '连接数',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_node_traffic_node_date` (`node_id`,`date`),
  KEY `idx_node_id` (`node_id`),
  KEY `idx_date` (`date`),
  CONSTRAINT `fk_nt_node` FOREIGN KEY (`node_id`) REFERENCES `nodes` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='节点日流量统计';

-- -----------------------------------------------------------------------------
-- 8. 用户分钟级流量 user_traffic_minute（反向自库）
-- -----------------------------------------------------------------------------
CREATE TABLE `user_traffic_minute` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `ts_minute` DATETIME NOT NULL COMMENT '时间粒度（到分钟，例如 2026-01-29 12:34:00）',
  `upload` BIGINT NOT NULL DEFAULT 0 COMMENT '该分钟内上传流量（字节）',
  `download` BIGINT NOT NULL DEFAULT 0 COMMENT '该分钟内下载流量（字节）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_utm_user_ts` (`user_id`,`ts_minute`),
  KEY `idx_utm_user` (`user_id`),
  KEY `idx_utm_ts` (`ts_minute`),
  CONSTRAINT `fk_utm_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户分钟级流量统计表';

-- -----------------------------------------------------------------------------
-- 9. 订阅表 subscriptions（反向自库）
-- -----------------------------------------------------------------------------
CREATE TABLE `subscriptions` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `token` VARCHAR(100) NOT NULL COMMENT '订阅令牌',
  `uuid` VARCHAR(36) DEFAULT NULL COMMENT '用户UUID（与订阅token绑定，重置token时同步更新）',
  `expires_at` DATETIME DEFAULT NULL COMMENT '过期时间',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `token` (`token`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_token` (`token`),
  KEY `idx_uuid` (`uuid`),
  CONSTRAINT `fk_sub_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订阅表';

-- -----------------------------------------------------------------------------
-- 10. 用户每日签到 user_signins（反向自库）
-- -----------------------------------------------------------------------------
CREATE TABLE `user_signins` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `date` DATE NOT NULL COMMENT '签到日期',
  `bonus_traffic` BIGINT NOT NULL DEFAULT 0 COMMENT '奖励流量（字节）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_signins_user_date` (`user_id`,`date`),
  CONSTRAINT `fk_user_signins_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户每日签到记录';

-- -----------------------------------------------------------------------------
-- 11. 面板设置 system_settings（反向自库）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `system_settings` (
  `id` INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `key` VARCHAR(64) NOT NULL COMMENT '配置键',
  `value` TEXT DEFAULT NULL COMMENT '配置值',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `key` (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='面板设置（panel_public_url=网站地址, site_name=站点名称）';

SET FOREIGN_KEY_CHECKS = 1;

-- -----------------------------------------------------------------------------
-- 示例数据：plan_groups
-- -----------------------------------------------------------------------------
INSERT INTO `plan_groups` (`id`, `group_key`, `name`, `level`, `is_exclusive`, `connections`, `speed_limit`, `status`, `is_public`, `sort_order`) VALUES
(1, 'basic',  '基础套餐', 0, 1, 2,  50, 1, 1, 0),
(2, 'pro',    '高级套餐', 1, 1, 3, 150, 1, 1, 1),
(3, 'signin', '签到套餐', 0, 0, 1,   0, 1, 1, 2),
(4, 'vip',    '单VIP节点', 0, 0, 1, 200, 1, 1, 3);

-- -----------------------------------------------------------------------------
-- 示例数据：plans（子套餐）
-- 流量换算：GB * 1024^3
-- -----------------------------------------------------------------------------
INSERT INTO `plans` (
  `id`, `group_id`, `name`, `description`,
  `price`, `duration_days`,
  `traffic_limit`, `speed_limit`, `connections`,
  `is_public`, `status`
) VALUES
(1, 1, '100G双终端包月', '基础套餐 100GB 双终端 月付',
  19.90, 30,
  107374182400, 0, 1,
  1, 1),
(2, 1, '1200G双终端包年', '基础套餐 1200GB 双终端 年付',
  199.00, 365,
  1288490188800, 0, 1,
  1, 1),
(3, 2, '300G多终端包月', '高级套餐 300GB 多终端 月付',
  39.90, 30,
  322122547200, 0, 1,
  1, 1),
(4, 2, '3600G多终端包年', '高级套餐 3600GB 多终端 年付',
  299.00, 365,
  3865470566400, 0, 1,
  1, 1),
(5, 3, '签到奖励-10分钟', '签到奖励：无流量（仅时长）',
  0.00, 1,
  0, 0, 1,
  0, 1),
(6, 4, '单VIP节点 2000G多终端包月', '单VIP节点 2000GB 多终端 月付',
  59.90, 30,
  2147483648000, 0, 1,
  1, 1);

-- -----------------------------------------------------------------------------
-- 示例数据：nodes
-- -----------------------------------------------------------------------------
INSERT INTO `nodes` (`name`, `address`, `port`, `protocol`, `config`, `status`, `sort_order`) VALUES
('香港节点1', 'hk1.example.com', 443, 'vmess', '{"id":"550e8400-e29b-41d4-a716-446655440000","alterId":64,"security":"auto","type":"none","host":"","path":"/vmess","tls":"tls"}', 1, 0),
('新加坡节点1', 'sg1.example.com', 443, 'vless', '{"id":"550e8400-e29b-41d4-a716-446655440000","flow":"xtls-rprx-vision","security":"none","type":"none","host":"","path":"/vless","tls":"xtls"}', 1, 1),
('美国节点1', 'us1.example.com', 443, 'trojan', '{"password":"your_password","type":"none","host":"","path":"/trojan","tls":"tls"}', 1, 2);

-- -----------------------------------------------------------------------------
-- 说明
-- -----------------------------------------------------------------------------
-- users 表不插入示例用户：请在前端 /auth/register 注册，或直接在 MySQL 插入后用 bcrypt 生成 password_hash。
-- 将某用户提权为管理员：UPDATE users SET role = 'admin' WHERE id = 1; 该用户需退出再重新登录后，前端才会显示管理员菜单。
