# 扣子演示：部署说明

GitHub Pages 仍然只负责网页，原项目和扣子 Web SDK 界面不变。访问者先输入演示访问码，再由 Worker 向扣子申请一个约 15 分钟的临时访问令牌。扣子 OAuth 签名私钥不进入 GitHub、网页、响应或日志；临时令牌会交给浏览器中的官方 SDK，仍应当视为凭证。

## 首次上线

1. **先在扣子撤销旧令牌。** 凡是写过网页源码、提交记录或发到聊天里的个人访问令牌都不要再用。清理网页不会让旧令牌失效；本次版本不改写历史。
2. 在扣子创建 **OAuth JWT 授权（开发者）** 应用，选择满足 Web SDK 所需的最少权限，尽量限定至独立的演示工作空间。按[扣子 Web SDK 文档](https://docs.coze.cn/developer_guides_vibe_coding_websdk)核对 `convertFileType`、`uploadFileToStorage`、`getMetadata(VibeProject)`、`run(VibeProject)`。签名用 RSA PKCS#8 PEM 私钥（首行为 `-----BEGIN PRIVATE KEY-----`）；JWT 固定使用 Web SDK 渠道 `2001`，这不等于锁定单个项目。参见[扣子 JWT 文档](https://docs.coze.cn/developer_guides_oauth_jwt)。
3. 在 `coze-auth` 目录用已登录的 Cloudflare Wrangler 4.36+ 部署。先核对 `wrangler.toml` 的 `PAGES_ORIGIN` 与实际网页源站（协议和域名，不带路径）。应用 ID 和公钥 ID 可放 Worker 配置；下面统一使用 [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)，值只粘贴到本地提示符，或在 Worker 控制台中用 **Secret** 类型录入。访问码使用密码管理器生成的 32 位以上无空格随机字符，且不要用任何扣子令牌代替它。

   ```sh
   npx wrangler deploy
   npx wrangler secret put COZE_CLIENT_ID
   npx wrangler secret put COZE_PUBLIC_KEY_ID
   npx wrangler secret put COZE_PRIVATE_KEY
   npx wrangler secret put DEMO_ACCESS_CODE
   ```

   初次部署未设置好密钥时接口会拒绝请求，不会退回公开令牌。若通过控制台粘贴私钥，请保留 PEM 的换行。管理员只把**演示访问码**给可信的使用者。此版本为单一演示身份，不面向不同访客做账号和对话隔离。限流是近似的，不能替代账号权限控制。
4. 在仓库根目录的 `coze-demo.mjs` 设置 `TOKEN_ENDPOINT` 为部署后的固定 HTTPS URL（末尾为 `/api/coze-token`）。该 URL 不是密钥。不应允许访客自填令牌服务地址。配好后再发布 GitHub Pages。
5. 验收：错码不得获取令牌；正确访问码可打开原项目并完成一次对话；到期时测试续期。检查网页源代码和公开静态文件不含个人令牌、私钥、访问码。静态检查和本地测试不能替代带真实配置的端到端测试。

## 如果要让任何访客直接打开

若这个扣子智能体可以公开，可以改用[扣子托管的分享产物](https://docs.coze.cn/guides_deploy_agent_as_api_service)。在扣子端确认它适合公开后，复制实际分享链接，并用未登录窗口确认可用，再把 GitHub Pages 改成入口链接。这个选项不用自建令牌服务，且不会把你的长期凭证放到网页里。它需要扣子侧已有或主动开启合适的公开分享，不能靠猜 URL 替代。
