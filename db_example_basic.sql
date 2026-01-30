-- =============================================================================
-- 数据库初始化脚本：ip_proxy_platform（根据 项目总览与对照说明.md、API-接口说明.md
-- 及 backend/src/routes 实际使用字段整理，供 Docker + 后端完整运行）
-- =============================================================================
-- 作用：创建库 + 5 张表（users, plans, orders, tickets, ticket_replies）+ 示例套餐
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
-- 1. 用户表 users（auth 注册/登录；admin 用户管理）
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `ticket_replies`;
DROP TABLE IF EXISTS `tickets`;
DROP TABLE IF EXISTS `orders`;
DROP TABLE IF EXISTS `plans`;
DROP TABLE IF EXISTS `users`;

CREATE TABLE `users` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `email` VARCHAR(100) NOT NULL UNIQUE COMMENT '邮箱（登录/通知）',
  `username` VARCHAR(50) NOT NULL UNIQUE COMMENT '用户名（登录显示名）',
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
  INDEX `idx_status` (`status`),
  INDEX `idx_invited_by` (`invited_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';

-- -----------------------------------------------------------------------------
-- 2.1 总套餐表 plan_groups（总套餐集合，不是可购买的套餐）
-- -----------------------------------------------------------------------------
CREATE TABLE `plan_groups` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `group_key` VARCHAR(100) NOT NULL UNIQUE COMMENT '总套餐唯一标识（例如 basic/pro/vip）',
  `name` VARCHAR(100) NOT NULL COMMENT '总套餐名称（例如 基础套餐、高级套餐）',
  `level` INT NOT NULL DEFAULT 0 COMMENT '等级/优先级（越大可用节点越多，用于升级判断）',
  `is_exclusive` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否互斥：1=互斥（与其他互斥总套餐不能共存），0=可与其他总套餐共存',
  `status` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '状态：1=启用,0=停用',
  `is_public` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否在套餐列表展示：1=展示，0=不展示（关则该总套餐下所有子套餐不在用户端套餐列表显示）',
  `sort_order` INT NOT NULL DEFAULT 0 COMMENT '排序顺序',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  INDEX `idx_status` (`status`),
  INDEX `idx_level` (`level`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='总套餐表（套餐集合，不是可购买的套餐）';
-- 若已有库无 is_public 字段，请执行：ALTER TABLE plan_groups ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否在套餐列表展示' AFTER status;

-- -----------------------------------------------------------------------------
-- 2.2 子套餐表 plans（/api/plans、/api/orders、admin 套餐管理）
-- -----------------------------------------------------------------------------
CREATE TABLE `plans` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `group_id` INT NOT NULL COMMENT '所属总套餐ID（外键 plan_groups.id）',
  `name` VARCHAR(100) NOT NULL COMMENT '子套餐名称（例如 基础套餐-月）',
  `description` TEXT DEFAULT NULL COMMENT '套餐说明',
  `price` DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '套餐价格（单一价格）',
  `duration_days` INT NOT NULL DEFAULT 30 COMMENT '套餐持续时间（天），到期即失效',
  `traffic_limit` BIGINT NOT NULL DEFAULT 0 COMMENT '总流量配额（字节，0=不限）',
  `speed_limit` INT NOT NULL DEFAULT 0 COMMENT '限速（Mbps，0=不限速）',
  `connections` INT NOT NULL DEFAULT 1 COMMENT '同时在线设备数',
  `is_public` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否上架/公开',
  `status` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '状态：1=启用,0=停用',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  CONSTRAINT `fk_plans_group` FOREIGN KEY (`group_id`) REFERENCES `plan_groups`(`id`) ON DELETE RESTRICT,
  INDEX `idx_status` (`status`),
  INDEX `idx_is_public` (`is_public`),
  INDEX `idx_group_id` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='子套餐表（可购买的套餐，等级/互斥规则从所属总套餐继承）';

-- -----------------------------------------------------------------------------
-- 3. 订单表 orders（/api/orders、admin 订单管理；pay_expire_at 由 created_at+30 分钟计算）
-- -----------------------------------------------------------------------------
CREATE TABLE `orders` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `plan_id` INT NOT NULL COMMENT '套餐ID',
  `order_no` VARCHAR(64) NOT NULL UNIQUE COMMENT '订单号',
  `trade_no` VARCHAR(128) DEFAULT NULL COMMENT '第三方支付单号（预留）',
  `amount` DECIMAL(10,2) NOT NULL COMMENT '订单金额',
  `pay_method` ENUM('balance','alipay','wechat','crypto') NOT NULL DEFAULT 'balance' COMMENT '支付方式',
  `status` ENUM('pending','paid','cancelled','expired') NOT NULL DEFAULT 'pending' COMMENT '订单状态',
  `duration_days` INT NOT NULL COMMENT '本订单有效期（天，创建时从套餐写入）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `paid_at` DATETIME DEFAULT NULL COMMENT '支付时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_orders_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON DELETE RESTRICT,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表';

-- -----------------------------------------------------------------------------
-- 4. 工单表 tickets（/api/tickets、admin 工单管理）
-- -----------------------------------------------------------------------------
CREATE TABLE `tickets` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `ticket_no` VARCHAR(64) NOT NULL UNIQUE COMMENT '工单号',
  `title` VARCHAR(200) NOT NULL COMMENT '标题',
  `content` TEXT NOT NULL COMMENT '内容',
  `category` ENUM('technical','billing','account','other') NOT NULL DEFAULT 'other' COMMENT '分类',
  `status` ENUM('open','in_progress','resolved','closed') NOT NULL DEFAULT 'open' COMMENT '状态',
  `priority` ENUM('low','medium','high','urgent') NOT NULL DEFAULT 'medium' COMMENT '优先级',
  `admin_id` INT DEFAULT NULL COMMENT '处理管理员ID',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `resolved_at` DATETIME DEFAULT NULL COMMENT '解决时间',
  CONSTRAINT `fk_tickets_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工单表';

-- -----------------------------------------------------------------------------
-- 5. 工单回复表 ticket_replies（/api/tickets/:id、/api/tickets/:id/reply、admin 回复）
-- -----------------------------------------------------------------------------
CREATE TABLE `ticket_replies` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `ticket_id` INT NOT NULL COMMENT '工单ID',
  `user_id` INT NOT NULL COMMENT '回复人ID',
  `is_admin` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否管理员回复',
  `content` TEXT NOT NULL COMMENT '回复内容',
  `attachments` JSON DEFAULT NULL COMMENT '附件列表(JSON，预留)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  CONSTRAINT `fk_tr_ticket` FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_tr_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  INDEX `idx_ticket_id` (`ticket_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工单回复表';

SET FOREIGN_KEY_CHECKS = 1;

-- -----------------------------------------------------------------------------
-- 6. 节点表 nodes（/api/nodes、admin 节点管理）
-- -----------------------------------------------------------------------------
CREATE TABLE `nodes` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `name` VARCHAR(100) NOT NULL COMMENT '节点名称',
  `address` VARCHAR(100) NOT NULL COMMENT '节点地址',
  `port` INT NOT NULL COMMENT '节点端口',
  `protocol` ENUM('vmess','vless','trojan','shadowsocks','hysteria2','socks','http','wireguard') NOT NULL COMMENT '节点协议',
  `config` TEXT NOT NULL COMMENT '节点配置（JSON格式）',
  `status` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '状态：1=启用,0=禁用',
  `sort_order` INT NOT NULL DEFAULT 0 COMMENT '排序顺序',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='节点表';

-- -----------------------------------------------------------------------------
-- 6.1 套餐可用节点关系表 plan_nodes（控制每个套餐能用哪些节点）
-- -----------------------------------------------------------------------------
CREATE TABLE `plan_nodes` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `plan_id` INT NOT NULL COMMENT '套餐ID',
  `node_id` INT NOT NULL COMMENT '节点ID',
  `priority` INT NOT NULL DEFAULT 0 COMMENT '优先级/权重（数值越大优先展示）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  CONSTRAINT `fk_plan_nodes_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_plan_nodes_node` FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON DELETE CASCADE,
  INDEX `idx_plan_id` (`plan_id`),
  INDEX `idx_node_id` (`node_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='套餐与可用节点的多对多关系表';

-- -----------------------------------------------------------------------------
-- 6.2 用户出站凭证表 user_clients（对接程序 / 外部认证使用的 UUID 等）
-- -----------------------------------------------------------------------------
CREATE TABLE `user_clients` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `uuid` CHAR(36) NOT NULL COMMENT '客户端唯一凭证（如 VLESS/VMess UUID）',
  `remark` VARCHAR(100) DEFAULT NULL COMMENT '备注（多设备或多协议时区分用）',
  `enabled` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用：1=启用,0=禁用',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  CONSTRAINT `fk_user_clients_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  UNIQUE KEY `uk_user_clients_uuid` (`uuid`),
  INDEX `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户在节点系统中的出站凭证（UUID 等）';

-- -----------------------------------------------------------------------------
-- 7. 节点连接表 node_connections（记录用户与节点的连接信息）
-- -----------------------------------------------------------------------------
CREATE TABLE `node_connections` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `node_id` INT NOT NULL COMMENT '节点ID',
  `ip` VARCHAR(45) NOT NULL COMMENT '连接IP',
  `start_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '开始连接时间',
  `end_time` DATETIME DEFAULT NULL COMMENT '结束连接时间',
  `upload` BIGINT NOT NULL DEFAULT 0 COMMENT '上传流量（字节）',
  `download` BIGINT NOT NULL DEFAULT 0 COMMENT '下载流量（字节）',
  `status` ENUM('active','closed') NOT NULL DEFAULT 'active' COMMENT '连接状态',
  CONSTRAINT `fk_nc_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_nc_node` FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON DELETE CASCADE,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_node_id` (`node_id`),
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='节点连接表';

-- -----------------------------------------------------------------------------
-- 8. 节点流量统计表 node_traffic（节点流量统计）
-- -----------------------------------------------------------------------------
CREATE TABLE `node_traffic` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `node_id` INT NOT NULL COMMENT '节点ID',
  `date` DATE NOT NULL COMMENT '统计日期',
  `upload` BIGINT NOT NULL DEFAULT 0 COMMENT '上传流量（字节）',
  `download` BIGINT NOT NULL DEFAULT 0 COMMENT '下载流量（字节）',
  `connections` INT NOT NULL DEFAULT 0 COMMENT '连接次数',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  CONSTRAINT `fk_nt_node` FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON DELETE CASCADE,
  UNIQUE KEY `uk_node_traffic_node_date` (`node_id`, `date`),
  INDEX `idx_node_id` (`node_id`),
  INDEX `idx_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='节点流量统计表';

-- -----------------------------------------------------------------------------
-- 9. 用户分钟级流量统计表 user_traffic_minute（用于总览图表/近24小时查询）
-- -----------------------------------------------------------------------------
CREATE TABLE `user_traffic_minute` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `ts_minute` DATETIME NOT NULL COMMENT '时间粒度（到分钟，例如 2026-01-29 12:34:00）',
  `upload` BIGINT NOT NULL DEFAULT 0 COMMENT '该分钟内上传流量（字节）',
  `download` BIGINT NOT NULL DEFAULT 0 COMMENT '该分钟内下载流量（字节）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  CONSTRAINT `fk_utm_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  UNIQUE KEY `uk_utm_user_ts` (`user_id`, `ts_minute`),
  INDEX `idx_utm_user` (`user_id`),
  INDEX `idx_utm_ts` (`ts_minute`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户分钟级流量统计表';

-- -----------------------------------------------------------------------------
-- 10. 订阅表 subscriptions（用户订阅链接）
-- -----------------------------------------------------------------------------
CREATE TABLE `subscriptions` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `token` VARCHAR(100) NOT NULL UNIQUE COMMENT '订阅令牌',
  `expires_at` DATETIME DEFAULT NULL COMMENT '过期时间',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  CONSTRAINT `fk_sub_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_token` (`token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订阅表';

-- -----------------------------------------------------------------------------
-- 11. 用户每日签到表 user_signins（签到领流量）
-- -----------------------------------------------------------------------------
CREATE TABLE `user_signins` (
  `id` INT PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  `user_id` INT NOT NULL COMMENT '用户ID',
  `date` DATE NOT NULL COMMENT '签到日期',
  `bonus_traffic` BIGINT NOT NULL DEFAULT 0 COMMENT '奖励流量（字节）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  CONSTRAINT `fk_user_signins_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  UNIQUE KEY `uk_user_signins_user_date` (`user_id`, `date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户每日签到记录（用于签到送流量、连续签到统计）';

-- -----------------------------------------------------------------------------
-- 10. 示例数据：nodes（节点管理用）
-- -----------------------------------------------------------------------------
INSERT INTO `nodes` (`name`, `address`, `port`, `protocol`, `config`, `status`, `sort_order`) VALUES
('香港节点1', 'hk1.example.com', 443, 'vmess', '{"id":"550e8400-e29b-41d4-a716-446655440000","alterId":64,"security":"auto","type":"none","host":"","path":"/vmess","tls":"tls"}', 1, 0),
('新加坡节点1', 'sg1.example.com', 443, 'vless', '{"id":"550e8400-e29b-41d4-a716-446655440000","flow":"xtls-rprx-vision","security":"none","type":"none","host":"","path":"/vless","tls":"xtls"}', 1, 1),
('美国节点1', 'us1.example.com', 443, 'trojan', '{"password":"your_password","type":"none","host":"","path":"/trojan","tls":"tls"}', 1, 2);

-- -----------------------------------------------------------------------------
-- 11. 示例数据：plan_groups（总套餐集合）
-- -----------------------------------------------------------------------------
INSERT INTO `plan_groups` (`group_key`, `name`, `level`, `is_exclusive`, `status`, `is_public`, `sort_order`) VALUES
('basic', '基础套餐', 0, 0, 1, 1, 0),
('pro', '高级套餐', 1, 0, 1, 1, 1),
('signin', '签到套餐', 0, 0, 1, 1, 2);

-- -----------------------------------------------------------------------------
-- 12. 示例数据：plans（子套餐，前端套餐列表、下单用）
-- 流量：100GB=107374182400 字节，300GB=322122547200 字节
-- -----------------------------------------------------------------------------
INSERT INTO `plans` (
  `group_id`, `name`, `description`,
  `price`, `duration_days`,
  `traffic_limit`, `speed_limit`, `connections`,
  `is_public`, `status`
) VALUES
((SELECT id FROM plan_groups WHERE group_key = 'basic' LIMIT 1), '基础套餐-月', '适合轻度使用，100GB，100Mbps，3 设备（30 天）',
  19.90, 30,
  107374182400, 100, 3,
  1, 1),
((SELECT id FROM plan_groups WHERE group_key = 'basic' LIMIT 1), '基础套餐-年', '适合轻度使用，1200GB，100Mbps，3 设备（365 天）',
  199.00, 365,
  1288490188800, 100, 3,
  1, 1),
((SELECT id FROM plan_groups WHERE group_key = 'pro' LIMIT 1), '高级套餐-月', '重度使用，300GB，300Mbps，5 设备（30 天）',
  39.90, 30,
  322122547200, 300, 5,
  1, 1),
((SELECT id FROM plan_groups WHERE group_key = 'pro' LIMIT 1), '高级套餐-年', '重度使用，3600GB，300Mbps，5 设备（365 天）',
  299.00, 365,
  3865470566400, 300, 5,
  1, 1),
((SELECT id FROM plan_groups WHERE group_key = 'signin' LIMIT 1), '签到奖励-10分钟', '每日签到奖励，有效期10分钟，流量随签到奖励动态计算',
  0.00, 1,
  0, 0, 1,
  0, 1);

-- -----------------------------------------------------------------------------
-- 7. 说明
-- -----------------------------------------------------------------------------
-- users 表不插入示例用户：请在前端 /auth/register 注册，或直接在 MySQL 插入后
-- 用 bcrypt 生成 password_hash。
--
-- 将某用户提权为管理员（需先注册或插入至少一条 users，再将 id=1 改为对应用户 id）：
--   UPDATE users SET role = 'admin' WHERE id = 1;
-- 该用户需退出再重新登录后，前端才会显示管理员菜单。
