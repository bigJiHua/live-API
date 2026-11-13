const mysql=require('mysql2/promise');
const {preflightTransaction}=require('../../../common/services/financialPreflight');
const {AiError}=require('./errors');

function createFinancialReadRepository(dbConfig,options={}) {
  if (dbConfig && (dbConfig.dbConfig || dbConfig.executor || dbConfig.now)) {
    options={...dbConfig,...options};dbConfig=options.dbConfig;
  }
  const now=options.now || (()=>new Date());
  const pool=options.executor || (dbConfig ? mysql.createPool({...dbConfig,connectionLimit:2,queueLimit:8,
    waitForConnections:true,multipleStatements:false,connectTimeout:5000,decimalNumbers:false}):null);
  async function read(work) {
    if (!pool) throw new AiError('资金只读连接尚未配置',503,'AI_FUNDS_READ_UNAVAILABLE');
    let conn;
    try {
      conn=pool.getConnection?await pool.getConnection():pool;
      await conn.query('SET TRANSACTION READ ONLY');await conn.beginTransaction();
      const guarded={execute:async(input,params)=>{
        const sql=typeof input==='string'?input:input?.sql;
        if (typeof sql!=='string' || !/^\s*SELECT\b/i.test(sql) || /\b(?:INSERT|UPDATE|DELETE|REPLACE|CALL)\b/i.test(sql))
          throw new AiError('预检只接受受控读取',403,'AI_FUNDS_READ_ONLY');
        return conn.execute({sql,timeout:5000},params);
      }};
      const select=async(sql,params)=>(await guarded.execute(sql,params))[0];
      const result=await work(select,guarded);
      await conn.rollback();return result;
    } catch (error) {
      if (conn) await conn.rollback().catch(()=>{});
      if (error instanceof AiError) throw error;
      throw new AiError('资金只读查询失败，请在本地复查',503,'AI_FUNDS_READ_UNAVAILABLE');
    } finally {if (conn?.release) conn.release();}
  }
  return {read,check:(userId,fields,config={})=>read((select,executor)=>preflightTransaction(executor,userId,fields,{...config,now:now()})),
    close:async()=>{if (!options.executor && pool?.end) await pool.end();}};
}
module.exports={createFinancialReadRepository};
