/**
 * ============================================================================
 *  相册图片添加工具 · Cloudflare Worker 代理
 * ============================================================================
 *
 *  作用：把 GitHub / ImgBed 的令牌藏在服务端，前端页面不再保存任何密钥。
 *
 *      浏览器 ──► 这个 Worker（密钥在这里）──► GitHub API / ImgBed
 *
 *  暴露的接口只有三个：
 *      GET  /api/auth     校验代理口令
 *      POST /api/gh       转发 GitHub 请求（只允许访问下面白名单里的那一个仓库）
 *      POST /api/upload   转发图床上传
 *
 *  ---------------------------------------------------------------------------
 *  部署步骤（5 分钟）
 *  ---------------------------------------------------------------------------
 *  1. 打开 https://dash.cloudflare.com → 左侧「Workers 和 Pages」→「创建」
 *     → 选「Worker」→ 起个名字（例如 album-tool）→「部署」
 *
 *  2. 部署后点「编辑代码」，把本文件全部内容粘进去覆盖，再点「部署」
 *
 *  3. 回到 Worker 的「设置」→「变量和密钥」，添加下面这些（类型选「密钥/Secret」的
 *     会加密存储，页面和日志里都看不到）：
 *
 *       GITHUB_TOKEN      【密钥】GitHub 令牌
 *                         强烈建议用 Fine-grained token，只授权
 *                         jingju5201314-create/imgbed-blog-config 这一个仓库，
 *                         权限只给 Contents: Read and write。
 *                         不要再用 classic 的 ghp_（那个能读写你所有仓库）。
 *
 *       IMGBED_TOKEN      【密钥】ImgBed 后台「API Token 管理」生成的上传令牌
 *                         权限只勾 Upload 就够，别给 Delete / Manage。
 *
 *       TOOL_KEY          【密钥】你自己定一个口令（例如一串 16 位随机字符）。
 *                         这是打开工具页面时要输入的密码 —— 口令校验在服务端，
 *                         控制台绕不过去，这是和原来那个前端假登录最大的区别。
 *
 *       IMGBED_BASE       【文本，可选】默认 https://ling520.ccwu.cc
 *       IMGBED_CHANNEL    【文本，可选】默认上传渠道，留空则由图床决定
 *                         （你的图床启用了 github、googledrive）
 *       ALLOWED_REPO      【文本，可选】默认 jingju5201314-create/imgbed-blog-config
 *       ALLOWED_ORIGIN    【文本，可选】默认 * （只允许工具的域名会更稳妥：
 *                         填 https://jingju5201314-create.github.io）
 *
 *  4. 部署完成后，Worker 会有一个地址，形如：
 *         https://album-tool.你的账号.workers.dev
 *     这个地址不是密钥，可以公开。把它填到工具的
 *     「① 令牌设置 → 高级选项 → 代理地址」里，刷新页面即可。
 *
 *  ---------------------------------------------------------------------------
 *  安全说明
 *  ---------------------------------------------------------------------------
 *  · 前端拿不到任何令牌。就算有人把页面源码扒光、把控制台翻烂也没用。
 *  · GitHub 那部分做了仓库白名单：即使代理地址泄露，别人也只能动这一个博客仓库，
 *    碰不到你的其他私有仓库，也改不了 GitHub Actions。
 *  · 想换令牌，只改这里的环境变量，不用重新部署前端页面。
 *  · workers.dev 在部分网络环境下会被拦截；如果打不开，可以在 Worker 的
 *    「设置 → 域和路由」里绑定一个你自己的域名。
 * ============================================================================
 */

const GITHUB_API = "https://api.github.com";

// CORS 头。工具页面和 Worker 不同源，必须放行。
function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": (env && env.ALLOWED_ORIGIN) || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Tool-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({}, corsHeaders(env), {
      "Content-Type": "application/json; charset=utf-8",
    }),
  });
}

// 把上游响应原样透传，只补 CORS —— 前端的错误处理逻辑完全不用改
function passthrough(res, env) {
  return new Response(res.body, {
    status: res.status,
    headers: Object.assign({}, corsHeaders(env), {
      "Content-Type": res.headers.get("Content-Type") || "application/json; charset=utf-8",
    }),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // ---- 口令校验：所有接口都要过这一关（服务端校验，绕不过去）----
    if (!env.TOOL_KEY) {
      return json({ error: "Worker 还没配置 TOOL_KEY，请到「设置 → 变量和密钥」添加" }, 500, env);
    }
    const key = request.headers.get("X-Tool-Key") || "";
    if (key !== env.TOOL_KEY) {
      return json({ error: "口令不对", code: "BAD_KEY" }, 401, env);
    }

    // ---- 口令校验接口（登录用）----
    if (url.pathname === "/api/auth") {
      return json({ ok: true }, 200, env);
    }

    // ---- GitHub 转发 ----
    if (url.pathname === "/api/gh") {
      if (request.method !== "POST") return json({ error: "只接受 POST" }, 405, env);

      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return json({ error: "请求体不是合法 JSON" }, 400, env);
      }

      const path = String(payload.path || "");
      const method = String(payload.method || "GET").toUpperCase();
      const body = payload.body;

      if (!path) return json({ error: "缺少 path" }, 400, env);
      if (["GET", "POST", "PATCH", "PUT", "DELETE"].indexOf(method) === -1) {
        return json({ error: "不支持的方法：" + method }, 405, env);
      }
      // 防目录穿越
      if (path.indexOf("..") !== -1) {
        return json({ error: "路径不合法" }, 400, env);
      }

      // ---- 仓库白名单：只允许动这一个仓库 ----
      const repo = env.ALLOWED_REPO || "jingju5201314-create/imgbed-blog-config";
      const plain = path.split("?")[0];
      const base = "/repos/" + repo;
      if (plain !== base && plain.indexOf(base + "/") !== 0) {
        return json({
          error: "这个路径不在白名单里，代理只允许访问 " + repo,
          code: "PATH_DENIED",
          got: plain,
        }, 403, env);
      }

      if (!env.GITHUB_TOKEN) {
        return json({ error: "Worker 还没配置 GITHUB_TOKEN" }, 500, env);
      }

      const headers = {
        Authorization: "Bearer " + env.GITHUB_TOKEN,
        Accept: "application/vnd.github+json",
        "User-Agent": "album-tool-worker",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      const init = { method: method, headers: headers };
      if (body !== undefined && body !== null) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }

      let res;
      try {
        res = await fetch(GITHUB_API + path, init);
      } catch (e) {
        return json({ error: "连接 GitHub 失败：" + e.message }, 502, env);
      }
      return passthrough(res, env);
    }

    // ---- 图床上传转发 ----
    if (url.pathname === "/api/upload") {
      if (request.method !== "POST") return json({ error: "只接受 POST" }, 405, env);
      if (!env.IMGBED_TOKEN) {
        return json({ error: "Worker 还没配置 IMGBED_TOKEN" }, 500, env);
      }

      let form;
      try {
        form = await request.formData();
      } catch (e) {
        return json({ error: "解析上传表单失败：" + e.message }, 400, env);
      }
      const file = form.get("file");
      if (!file || typeof file === "string") {
        return json({ error: "表单里没有文件字段 file" }, 400, env);
      }

      const out = new FormData();
      out.append("file", file, file.name || "image");

      const qs = new URLSearchParams();
      const channel = url.searchParams.get("uploadChannel") || env.IMGBED_CHANNEL || "";
      if (channel) qs.set("uploadChannel", channel);
      const folder = url.searchParams.get("uploadFolder");
      if (folder) qs.set("uploadFolder", folder);

      const base = String(env.IMGBED_BASE || "https://ling520.ccwu.cc").replace(/\/+$/, "");

      let res;
      try {
        res = await fetch(base + "/upload" + (qs.toString() ? "?" + qs.toString() : ""), {
          method: "POST",
          headers: { Authorization: env.IMGBED_TOKEN },
          body: out,
        });
      } catch (e) {
        return json({ error: "连接图床失败：" + e.message }, 502, env);
      }
      return passthrough(res, env);
    }

    // ---- 根路径给个自检页面，方便确认部署成功 ----
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "album-tool proxy is running.\n\n" +
        "endpoints:\n" +
        "  GET  /api/auth     (需要 X-Tool-Key)\n" +
        "  POST /api/gh       (需要 X-Tool-Key)\n" +
        "  POST /api/upload   (需要 X-Tool-Key)\n",
        { status: 200, headers: Object.assign({}, corsHeaders(env), { "Content-Type": "text/plain; charset=utf-8" }) }
      );
    }

    return json({ error: "没有这个接口：" + url.pathname }, 404, env);
  },
};
