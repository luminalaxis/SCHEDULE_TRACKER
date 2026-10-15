// Command-line admin for when the web admin page is out of reach (locked out, fresh install, disaster recovery).
//   node server/cli.js list-users
//   node server/cli.js create-user <username> <developer|treasurer|member|viewer> [이름]
//   node server/cli.js reset-password <username>
//   node server/cli.js backup
//   node server/cli.js restore <backup.json> [--force]
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, createDocs } from "./store.js";
import { createAuth, tempPassword, checkUsername, ROLES } from "./auth.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR || join(ROOT, "data");
const db = openStore(dataDir), docs = createDocs(db), auth = createAuth(db);
const [cmd, ...args] = process.argv.slice(2);
const audit = (action, target, detail) => db.prepare("INSERT INTO audit (at, actor, actor_name, action, target, detail, ip) VALUES (?, NULL, 'cli', ?, ?, ?, 'local')").run(new Date().toISOString(), action, target, detail);
const die = (msg) => { console.error(msg); process.exit(1); };

switch (cmd) {
  case "list-users":
    console.table(auth.list().map((u) => ({ 아이디: u.username, 이름: u.name, 역할: u.role, 상태: u.status, 마지막로그인: u.last_login || "" })));
    break;
  case "create-user": {
    const [username, role, name] = args;
    if (checkUsername(username || "")) die(checkUsername(username || ""));
    if (!ROLES.includes(role)) die(`역할은 ${ROLES.join(", ")} 중 하나예요.`);
    if (auth.byUsername(username)) die("이미 있는 아이디예요.");
    const pw = tempPassword();
    auth.create({ username, name: name || username, dept: "", role, status: "active", password: pw, mustChange: true });
    audit("user.create", username, `${role} (cli)`);
    console.log(`만들었어요: ${username} (${role})\n임시 비밀번호: ${pw}\n처음 로그인할 때 새 비밀번호를 정하게 돼요. 역할 변경이 페이지에 반영되려면 서버를 다시 시작하거나 관리 창에서 역할을 한 번 저장하세요.`);
    break;
  }
  case "reset-password": {
    const u = auth.byUsername(args[0] || "");
    if (!u) die("그런 아이디가 없어요.");
    const pw = tempPassword();
    auth.setPassword(u.id, pw, true); auth.endAllSessions(u.id);
    if (u.status !== "active") auth.update(u.id, { status: "active" });
    audit("user.reset_password", u.username, "cli");
    console.log(`${u.username} 임시 비밀번호: ${pw}`);
    break;
  }
  case "backup": {
    const { createBackup } = await import("./server.js");
    console.log("백업했어요:", createBackup("manual", null, "cli"));
    process.exit(0);
  }
  case "restore": {
    const file = args[0]; if (!file) die("백업 파일 경로를 적어 주세요.");
    const json = JSON.parse(readFileSync(file, "utf8"));
    if (json.format !== "fsk-backup") die("피트보드 백업 파일이 아니에요.");
    if ((auth.count() || docs.all().length) && !args.includes("--force")) die("데이터가 이미 있어요. 덮어쓰려면 --force 를 붙이세요 (계정·데이터·설정을 모두 백업 시점으로 바꿔요).");
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM sessions; DELETE FROM users;");
      const ins = db.prepare("INSERT INTO users (id, username, name, dept, role, status, pw_hash, must_change_pw, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const u of json.users || []) ins.run(u.id, u.username, u.name, u.dept || "", u.role, u.status, u.pw_hash, u.must_change_pw || 0, u.created_at, u.last_login || null);
      const set = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      for (const [k, v] of Object.entries(json.settings || {})) set.run(k, JSON.stringify(v));
      const a = db.prepare("INSERT OR REPLACE INTO assets (id, content_type, size, uploader, name, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const x of json.assets || []) a.run(x.id, x.content_type, x.size, x.uploader, x.name, x.created_at);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    docs.replaceAll(json.docs || []);
    audit("backup.restore", file, `full restore (cli) · ${json.docs?.length || 0} docs · ${json.users?.length || 0} users`);
    console.log(`복원했어요: 문서 ${json.docs?.length || 0}개, 계정 ${json.users?.length || 0}개. 첨부 파일은 data/assets 폴더를 따로 복사해 넣어야 해요.`);
    break;
  }
  default:
    console.log(`사용법:
  node server/cli.js list-users
  node server/cli.js create-user <아이디> <developer|treasurer|member|viewer> [이름]
  node server/cli.js reset-password <아이디>
  node server/cli.js backup
  node server/cli.js restore <백업.json> [--force]`);
}
db.close();
