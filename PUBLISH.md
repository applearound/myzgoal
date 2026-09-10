# myzgoal 发布到 npm 操作指南

> 目标:把本仓库作为 pi 包发布到 npm 官方仓库,使任何用户可执行 `pi install npm:myzgoal` 完成安装。
> 当前版本基线:`package.json` 与 git tag 均为 `v0.3.0`,且一一对应。

## 一、前提状态盘点

| 事项 | 状态 |
| --- | --- |
| `pi.extensions` 字段指向 `./src/index.ts` | ✅ 已就绪 |
| `files` 字段限定 `src` / `README.md` / `LICENSE` | ✅ 已就绪 |
| `keywords` 含 `pi-package`(自动收录进 pi.dev 图库) | ✅ 已就绪 |
| `LICENSE`(MIT)与 `license` 字段 | ✅ 已就绪 |
| 版本与 git tag 对齐(发布即 tag 的既定 workflow) | ✅ 已就绪 |
| package.json 依赖结构 | ⚠ 需修正(见第二节) |
| npm 账号登录 | ⚠ 未完成(见第三节) |
| 发布内容 dry-run 核验 | ⚠ 未完成(见第四节) |
| 本地真机验证(pi install 本地路径) | ⚠ 未完成(见第五节) |

## 二、修正 package.json 依赖结构(硬性规则)

pi 官方规定(docs/packages.md):**pi 内置捆绑的核心包不得随包发布**,必须声明在 `peerDependencies` 且范围 `"*"`。核心包清单:`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`。

当前问题:

1. `typebox` 在 `dependencies` 里,但代码中**没有任何 import**,应直接删除;
2. `@earendil-works/pi-tui` 是唯一运行时导入(render.ts、config-ui.ts),但它是核心包,应移入 `peerDependencies`;
3. `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai` 仅作类型导入,同属核心包,也应移入 `peerDependencies`;
4. 缺 `engines` 声明。

修正后的完整 package.json:

```json
{
  "name": "myzgoal",
  "version": "0.3.0",
  "description": "/goal for PI Agent — set a completion condition and pi keeps working until it's met",
  "type": "module",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+ssh://git@github.com/applearound/myzgoal.git"
  },
  "keywords": ["pi", "pi-extension", "pi-package", "goal", "agent"],
  "main": "src/index.ts",
  "engines": {
    "node": ">=20"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "peerDependencies": {
    "typebox": "*",
    "@earendil-works/pi-tui": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0"
  },
  "files": ["src", "README.md", "LICENSE"]
}
```

要点:

- `peerDependencies: "*"` 表示"版本由宿主 pi 提供",pi 安装本包时执行生产安装(`npm install --omit=dev`),peer 依赖不会被安装第二份,运行时由 pi 自己的模块解析命中;
- `devDependencies` 保留 typescript 与类型,仅本地开发用,不会进 tarball;
- `files` 已确保 `node_modules`(本地是指向全局安装的符号链接)不进包。

## 三、npm 账号与官方源(需账号持有人亲自执行)

1. 登录(浏览器认证,建议开启 2FA):

   ```bash
   npm login
   npm whoami   # 验证登录态
   ```

2. 本机 npm 源当前指向腾讯镜像,发布必须走官方源。两种处理方式(推荐 A):

   **A. 发布命令显式指定**(不影响日常安装源):

   ```bash
   npm publish --registry=https://registry.npmjs.org
   ```

   **B. 临时切换**:在仓库根目录创建 `.npmrc`(勿提交)写入:

   ```ini
   registry=https://registry.npmjs.org
   ```

3. 包名终确认(镜像源的 404 不能作为依据):

   ```bash
   npm view myzgoal --registry=https://registry.npmjs.org
   # 404 = 未占用,可发布;有返回 = 被占用,改用 scope 名 @applearound/myzgoal
   ```

## 四、发布内容 dry-run 核验

```bash
npm pack --dry-run     # 检查 tarball 文件列表:应只含 src/*、README.md、LICENSE、package.json
npm publish --dry-run  # 模拟发布:检查体积与最终内容
```

核验要点:

- tarball 中**不得出现** `node_modules`(本地是符号链接,打进包会导致安装失败);
- tarball 中必须包含 `src/index.ts`(pi.extensions 入口)、`package.json`、`README.md`、`LICENSE`;
- 包体积应为几 KB 量级(纯 TS 源码,无编译产物)。

## 五、发布前真机验证(不依赖 npm)

pi 支持本地路径安装,可完整验证"作为包被加载"链路(与 `-e` 直载文件不同,它走 `pi.extensions` 字段):

```bash
pi install /Users/yezhou/Dev/mine/myzgoal   # 写入用户 settings
pi list                                     # 确认出现在已装列表
# 启动 pi,验证:
#   /goal <条件> 设置目标并自动续跑
#   /goal-config 配置界面正常打开、保存
#   /reload 后扩展仍正常
pi remove /Users/yezhou/Dev/mine/myzgoal    # 验完移除
```

## 六、正式发布

前置(二~五)全部完成后:

```bash
git checkout main && git pull
npm version patch   # 或 minor / major;自动改 package.json 版本并打 vX.Y.Z tag
git push && git push --tags
npm publish --registry=https://registry.npmjs.org
```

版本策略(与既有 git workflow 对齐):

- 修复 → patch;新增功能 → minor;破坏性变更 → major
- 先 bump/tag 推送,再 publish——保证 npm 版本与 git tag 严格一一对应
- 若 publish 失败但 tag 已推,用 `npm version` 重试前先确认失败原因,勿盲目覆盖 tag

## 七、发布后验证

```bash
pi -e npm:myzgoal             # 临时试装(不写入 settings),验证包完整性
pi install npm:myzgoal        # 正式安装
pi update npm:myzgoal         # 后续升级
```

同时确认 [pi.dev/packages](https://pi.dev/packages) 图库已收录(`pi-package` keyword 自动触发;如需预览可在 `pi` 字段加 `image`/`video`)。

## 八、常见问题

| 问题 | 处理 |
| --- | --- |
| 包名被占用 | 改用 scope:`@applearound/myzgoal`,同步更新 `pi install npm:@applearound/myzgoal` 文档 |
| `ENEEDAUTH` | 未登录或 2FA 未通过;`npm login` 后重试 |
| publish 报 403 | registry 指向了镜像;确认 `--registry=https://registry.npmjs.org` |
| 用户安装后扩展不加载 | 检查 tarball 是否含 `src/index.ts`(`npm pack --dry-run`),确认 `pi.extensions` 路径与 files 字段一致 |
| 安装后报缺 `@earendil-works/*` | 核心包必须放 `peerDependencies` 而非 `dependencies`;pi 自带这些模块,无需捆绑 |
| 想撤销某版本 | `npm unpublish myzgoal@x.y.z`(72 小时内、无大量下载;否则改用 `npm deprecate`) |
