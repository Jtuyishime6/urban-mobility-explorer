const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createApp } = require('./app');

const databasePath = path.resolve(
    process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'urban_mobility.sqlite')
);
const port = Number(process.env.PORT || 5000);
const host = process.env.HOST || '127.0.0.1';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
}
if (!fs.existsSync(databasePath)) {
    throw new Error(
        `SQLite database not found at ${databasePath}. Run backend/etl.py before starting the API.`
    );
}

const database = new Database(databasePath, { readonly: true, fileMustExist: true });
database.pragma('query_only = ON');
const app = createApp(database);
const server = app.listen(port, host, () => {
    console.log(`Urban Mobility API listening on http://${host}:${port}; database: ${databasePath}`);
});

function shutdown() {
    server.close(() => {
        database.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
