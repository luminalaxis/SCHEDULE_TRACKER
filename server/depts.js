// The team's departments: the one list the server, the CLI, notifications, the login page and /admin all use.
// index.html (also the claude.ai Artifact) keeps its own DEPTS with colors and measurement fields;
// test/units.test.js checks that its keys and names match this list.
export const DEPARTMENTS = { battery: "배터리", circuit: "회로", chassis: "프레임·현가", aero: "에어로", powertrain: "파워트레인" };
export const DEPTS = Object.keys(DEPARTMENTS);
export const deptLabel = (k) => (Object.hasOwn(DEPARTMENTS, k) ? DEPARTMENTS[k] : "");
// login.html and admin.html are served by the server, which fills in this placeholder.
export const DEPTS_PLACEHOLDER = "/*DEPARTMENTS*/{}";
