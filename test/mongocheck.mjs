// Quick diagnostic: can we reach Atlas, and which database holds the accounts?
// Usage: node test/mongocheck.mjs "<connection string>"
import { MongoClient } from "mongodb";

const uri = process.argv[2] || process.env.MONGODB_URI;
if (!uri) {
  console.error("pass the connection string as the first argument");
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
  console.log("CONNECTED OK");
  for (const dbName of ["kairos", "exalted"]) {
    const db = client.db(dbName);
    const users = await db.collection("users").countDocuments().catch(() => -1);
    const sessions = await db.collection("sessions").countDocuments().catch(() => -1);
    const userdata = await db.collection("userdata").countDocuments().catch(() => -1);
    console.log(`db "${dbName}": users=${users} sessions=${sessions} userdata=${userdata}`);
  }
} catch (err) {
  console.log("CONNECT FAILED:", err.message);
} finally {
  await client.close().catch(() => {});
}
