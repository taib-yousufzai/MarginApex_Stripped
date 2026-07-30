import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const secret = process.env.AUTOLOGIN_SECRET;
  const url = `http://localhost:3000/api/cron/sync-instruments?secret=${secret}`;
  console.log(`Triggering sync at ${url}`);
  try {
    const res = await fetch(url);
    const data = await res.json();
    console.log(data);
  } catch (err) {
    console.error(err);
  }
}
main();
