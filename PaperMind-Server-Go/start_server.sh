#!/bin/bash
# 临时启动脚本：构建 + 代理出站 + 启动 Go 服务（用完可删）
cd /mnt/e/Code/PaperMind-Coze/PaperMind-Server-Go || exit 1
BIN="$HOME/pmsg-server"
go build -o "$BIN" ./cmd/server || exit 1
HOSTIP=$(ip route show default | awk '{print $3}')
export http_proxy="http://$HOSTIP:16888"
export https_proxy="http://$HOSTIP:16888"
export HTTP_PROXY="$http_proxy"
export HTTPS_PROXY="$https_proxy"
export no_proxy="localhost,127.0.0.1"
export NO_PROXY="localhost,127.0.0.1"
# 对拍期间与 TS 版共用同一份上传文件
export UPLOAD_DIR=/mnt/e/Code/PaperMind-Server/uploads
echo "proxy: $https_proxy"
exec env PORT=9091 "$BIN"
