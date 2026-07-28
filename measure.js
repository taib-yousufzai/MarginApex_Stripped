const fs = require('fs');
let c = fs.readFileSync('app/api/positions/[id]/close/route.ts', 'utf8');

c = c.replace('export async function POST(', 'export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {\n  const startTime = Date.now();\n  const logTime = (label: string) => console.log([Timer] \: \ms);\n');
c = c.replace(/export async function POST\([\s\S]*?\{/, 'export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {');
c = c.replace('const admin = getAdminClient();', 'const admin = getAdminClient(); logTime("Started DB Queries");');
c = c.replace('const { data: pos, error: posErr } = posResult;', 'const { data: pos, error: posErr } = posResult; logTime("Finished initial DB fetch");');
c = c.replace('const currentHHMM =', 'logTime("Finished trading hours check"); const currentHHMM =');
c = c.replace('const { data: segSetting } = segSettingResult;', 'const { data: segSetting } = segSettingResult; logTime("Finished LTP and Segment fetch");');
c = c.replace('const response: ClosePositionResponse = {', 'logTime("Finished RPC close"); const response: ClosePositionResponse = {');

fs.writeFileSync('app/api/positions/[id]/close/route.ts', c);
