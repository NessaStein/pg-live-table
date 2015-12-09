import _ from 'lodash';
import {EventEmitter} from 'events';
let pg = require('pg');

function Table(name) {
    let ee = new EventEmitter();
    return {
        ee,
        name
    };
}

export default function LiveTable(options = {}) {
    let log = require('logfilename')(__filename, options.logOptions);
    let channel = options.channel || 'livetable';
    if (!options.dbUrl) {
        throw Error('missing dbUrl options');
    }
    let client;
    let tableMap = new Map();

    return {
        query,
        connect,
        async listAllTables(){
            let listAllTables = `
                SELECT c.relname As tablename
                FROM pg_catalog.pg_class c
                     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r')
                      AND n.nspname <> 'pg_catalog'
                      AND n.nspname <> 'information_schema'
                      AND n.nspname !~ '^pg_toast'
                  AND pg_catalog.pg_table_is_visible(c.oid);`;
            let result = await query(listAllTables);
            log.debug(`listAllTables: ${JSON.stringify(result)}`);
            return _.map(result.rows, row => row.tablename);
        },
        async listen() {
            await query(`LISTEN "${channel}"`);
            let client = await getClient();
            client.on('notification', onNotification);
        },
        async monitor(tableName) {
            if(tableMap.has(tableName)){
                throw Error(`table ${tableName} already exist`);
            }
            let table = Table(tableName);
            tableMap.set(tableName, table);

            await createTableTrigger(tableName, channel);
            return table.ee;
        },

        async version() {
            log.debug(`version`);
            return query("select version()");
        },
        async close(){
            log.debug("close");
            for(let table of tableMap.values()) {
                table.ee.removeAllListeners();
            };
            let client = await getClient();
            client.end();
        }
    };

    function convertOp(op){
        return op.toLowerCase();
    }
    function onNotification(info){
        if (info.channel === channel) {
            try {
                let payload = JSON.parse(info.payload);
                let table = tableMap.get(payload.table);
                if(table){
                    log.debug(`notification payload: ${JSON.stringify(payload, null, 4)}`);
                    table.ee.emit(convertOp(payload.op), payload);
                } else {
                    log.error(`table not registered: ${payload.table}`);
                }
            } catch (error) {
                log.error(`${error}`);
                //TODO
                /*
                return this.emit('error',
                    new Error('INVALID_NOTIFICATION ' + info.payload))
                    */
            }
        } else {
            log.error(`channel not registered: ${channel}`);
        }
    }
    async function connect() {
        log.debug(`connecting to ${options.dbUrl}`);

        return new Promise(function (resolve, reject) {
            pg.connect(options.dbUrl, function (error, client) {
                if (error) {
                    reject(error);
                } else {
                    log.debug(`connected to ${options.dbUrl}`);
                    resolve(client);
                }
            });
        });
    }
    async function getClient(){
        if(!client){
            log.debug(`getClient: creating client`);
            client = await connect();
        };
        return client;
    };
    async function query(command) {
        try {
            //log.debug(`query: ${command}`);
            let client = await getClient();
            let params = arguments[2] === undefined ? [] : arguments[2];

            return new Promise(function (resolve, reject) {
                client.query(command, params, function (error, result) {
                    if (error) reject(error);
                    else resolve(result);
                });
            });
        } catch (error) {
            log.error(error);
            throw error;
        }
    }
    async function createTableTrigger(table, channel) {
        log.debug(`createTableTrigger table: ${table} channel: ${channel}`);
        let triggerName = `${channel}_${table}`;

        let payloadTpl = `
            SELECT
                '${table}'  AS table,
                TG_OP       AS op,
                json_agg($ROW$) AS data
            INTO row_data;
        `;
        let payloadNew = payloadTpl.replace(/\$ROW\$/g, 'NEW')
        let payloadOld = payloadTpl.replace(/\$ROW\$/g, 'OLD')
        let payloadChanged = `
            SELECT
                '${table}'  AS table,
                TG_OP       AS op,
                json_agg(NEW) AS new_data,
                json_agg(OLD) AS old_data
            INTO row_data;
        `

        await query(
            `CREATE OR REPLACE FUNCTION ${triggerName}() RETURNS trigger AS $$
                DECLARE
          row_data RECORD;
        BEGIN
          RAISE WARNING '${triggerName}';
          IF (TG_OP = 'INSERT') THEN
            ${payloadNew}
          ELSIF (TG_OP  = 'DELETE') THEN
            ${payloadOld}
          ELSIF (TG_OP = 'UPDATE') THEN
            ${payloadChanged}
          END IF;
          PERFORM pg_notify('${channel}', row_to_json(row_data)::TEXT);
          RETURN NULL;
                END;
            $$ LANGUAGE plpgsql`);

        await query(
            `DROP TRIGGER IF EXISTS "${triggerName}"
                ON "${table}"`);

        await query(
            `CREATE TRIGGER "${triggerName}"
                AFTER INSERT OR UPDATE OR DELETE ON "${table}"
                FOR EACH ROW EXECUTE PROCEDURE ${triggerName}()`);

        return true;
    };
};
