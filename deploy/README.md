# Linux 服务安装

安装、systemd user unit、配置路径、备份与回滚统一维护在 [README 的运维章节](../README.md#运维备份与回滚)。机器人注册与后台权限检查见 [飞书机器人设置](../docs/feishu-setup.md)。

以运行终端后端的同一用户执行 `bash deploy/install.sh`。安装器保留已有配置，不启动服务，不执行 sudo；看到 setup 的 `SETUP OK` 并确认后端配置后再启动。
