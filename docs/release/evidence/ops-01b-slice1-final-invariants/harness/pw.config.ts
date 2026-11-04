// Evidence-run wrapper: the repository's playwright.config.ts unchanged, except that Playwright does NOT start the web
// servers (the operator starts `pnpm dev` on :3000 per run, with its log captured). The :3100 production build is only
// used by the "pwa" project, which is not part of this gate.
import base from "C:/Users/Reem/Desktop/shopkhata/playwright.config";
export default { ...base, testDir: "C:/Users/Reem/Desktop/shopkhata/tests/e2e", webServer: undefined };
