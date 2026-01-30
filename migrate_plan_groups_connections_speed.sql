-- 为已有库的 plan_groups 表增加 共享设备、限速 列（若列已存在会报错，可忽略）
-- 执行：mysql -u root -p ip_proxy_platform < migrate_plan_groups_connections_speed.sql

USE ip_proxy_platform;

ALTER TABLE plan_groups
  ADD COLUMN connections INT NOT NULL DEFAULT 1 COMMENT '共享设备数（该总套餐下所有子套餐共用)' AFTER sort_order;
ALTER TABLE plan_groups
  ADD COLUMN speed_limit INT NOT NULL DEFAULT 0 COMMENT '限速 Mbps，0=不限' AFTER connections;
