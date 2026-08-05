# 宝塔 / 阿里云部署

公网只部署 `public/`，不要运行或反向代理 `server.mjs`。服务器上的公网网页只能展示访客导入的 JSON 报告，不能替访客读取或清理其电脑文件。

## 宝塔静态站点

1. 在阿里云安全组放行 TCP `80` 和 `443`。
2. 在宝塔「网站」中创建 `codextest.com`，同时填写 `www.codextest.com`，运行环境选择静态。
3. 将 `public/` 内容上传到 `/www/wwwroot/codextest.com/public`，或把站点根目录直接设为该目录。
4. 在站点配置中加入 `nginx-codextest.conf` 的 `location` 和安全响应头；不要开启站点级 Basic Auth/访问密码。
5. 在宝塔申请 Let's Encrypt 证书，确认 `https://www.codextest.com` 可访问后再开启强制 HTTPS。

## DNS

在实际托管 DNS 的服务商处设置：

```text
@      A      <阿里云 ECS 公网 IPv4>
www    A      <阿里云 ECS 公网 IPv4>
```

删除旧的 AAAA/CNAME 冲突记录。使用 `dig +short www.codextest.com` 确认返回 ECS 地址后再申请证书。

## 本机扫描

其他用户若要扫描自己的电脑，下载项目并在本机运行：

```bash
npm install
npm start
```

然后打开 `http://127.0.0.1:4173`。也可以运行 `npm run scan --silent > ssd-write-guard-report.json`，在公网网页点击「导入报告」。报告不包含文件内容、用户名、主机名或对话内容。

