const crypto = require('crypto');
const db = require('../../../common/config/db');
const { encryptField, decryptField, isEncrypted } = require('../../../common/utils/fieldCrypto');
const { digestInput } = require('./requestGuard');
const { AiError } = require('./errors');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

function createTransactionCandidateStore({ executor = db, now = Date.now, ttl = 15 * 60 * 1000 } = {}) {
  const stamp = () => new Date(now()).getTime();
  function unpack(row) {
    if(!row) throw new AiError('候选不存在或已过期',404,'AI_CANDIDATE_EXPIRED');
    if(row.payload==='expired') return {id:row.id,sourceCandidateId:row.id,source:row.source,status:row.status,
      conversationId:row.conversation_id,draftId:row.draft_id||null,fields:{},trace:[],eligible:false,
      expiresAt:Number(row.expires_at),inputDigest:row.input_digest};
    if (!row || !isEncrypted(row.payload)) throw new AiError('候选不存在或已过期',404,'AI_CANDIDATE_EXPIRED');
    let payload; try { payload = JSON.parse(decryptField(row.payload)); } catch (_) { throw new AiError('候选校验失败',409,'AI_CANDIDATE_INVALID'); }
    if (digestInput(payload) !== row.input_digest) throw new AiError('候选校验失败',409,'AI_CANDIDATE_INVALID');
    return { ...payload,id:row.id,sourceCandidateId:row.id,status:row.status,draftId:row.draft_id || null,expiresAt:Number(row.expires_at),inputDigest:row.input_digest };
  }
  async function get(userId,id,conn=executor,{ lock=false,allowEnded=false }={}) {
    if (!userId || !uuid(id)) throw new AiError('候选编号不合法',400,'AI_CANDIDATE_INVALID');
    const [rows] = await conn.execute(`SELECT * FROM ai_transaction_candidate WHERE user_id=? AND id=? LIMIT 1${lock?' FOR UPDATE':''}`,[userId,id]);
    if (!rows[0]) throw new AiError('候选不存在或已过期',404,'AI_CANDIDATE_EXPIRED');
    const value = unpack(rows[0]);
    if (value.status !== 'consumed' && value.expiresAt <= stamp()) {
      if(allowEnded) return {...value,status:'expired'};
      throw new AiError('候选已过期，请重新核查',410,'AI_CANDIDATE_EXPIRED');
    }
    if (!allowEnded && ['failed','discarded'].includes(value.status)) throw new AiError('本次候选已结束，不会重新生成草稿',409,'AI_CANDIDATE_ENDED');
    return value;
  }
  async function save(userId,input,conn=executor) {
    const { requestId=null,sourceFingerprint=null,...payload } = input;
    if (!userId || !['user-readonly','image-ocr'].includes(payload.source) || !payload.fields ||
        (requestId!=null && !uuid(requestId)) || (sourceFingerprint!=null && !/^[a-f0-9]{64}$/.test(sourceFingerprint))) {
      throw new AiError('候选来源或字段不合法',400,'AI_CANDIDATE_INVALID');
    }
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized)>64*1024 || /data:image\/|"dataUrl"\s*:/.test(serialized)) throw new AiError('候选内容过大或包含图片',400,'AI_CANDIDATE_INVALID');
    const inputDigest=digestInput(payload),id=crypto.randomUUID(),createdAt=stamp();
    await conn.execute(`UPDATE ai_transaction_candidate SET payload='expired',status=IF(status='pending','failed',status)
      WHERE user_id=? AND payload<>'expired' AND ((status<>'consumed' AND expires_at<=?) OR created_at<?) LIMIT 100`,
      [userId,createdAt,createdAt-90*86400000]);
    try {
      await conn.execute(`INSERT INTO ai_transaction_candidate (id,user_id,source,conversation_id,request_id,source_fingerprint,input_digest,payload,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,[id,userId,payload.source,payload.conversationId||null,requestId,sourceFingerprint,inputDigest,encryptField(serialized),createdAt,createdAt+ttl]);
      return get(userId,id,conn);
    } catch(error) {
      if(error.code!=='ER_DUP_ENTRY') throw error;
      const [rows]=await conn.execute(`SELECT * FROM ai_transaction_candidate WHERE user_id=? AND
        ((? IS NOT NULL AND request_id=?) OR (? IS NOT NULL AND source_fingerprint=?)) LIMIT 1`,[userId,requestId,requestId,sourceFingerprint,sourceFingerprint]);
      if(!rows[0]) throw new AiError('候选冲突，请读取原回执',409,'AI_CANDIDATE_CONFLICT');
      if(requestId && rows[0].input_digest!==inputDigest) throw new AiError('同一请求编号不能改变交易内容',409,'AI_CANDIDATE_CONFLICT');
      return get(userId,rows[0].id,conn);
    }
  }
  async function findByFingerprint(userId,fingerprint,conn=executor) {
    const [rows]=await conn.execute('SELECT * FROM ai_transaction_candidate WHERE user_id=? AND source_fingerprint=? LIMIT 1',[userId,fingerprint]);
    if(!rows[0]) return null;
    // Expired/ended same-source tombstones are not permission to create a second transaction.
    return unpack(rows[0]);
  }
  async function restorePending(userId,input,conn=executor) {
    const { sourceFingerprint, ...payload } = input;
    if (!userId || !uuid(payload.pendingTaskId) || !uuid(payload.conversationId) ||
        !Number.isInteger(payload.pendingTaskIndex) || payload.pendingTaskIndex < 0 || payload.pendingTaskIndex > 2 ||
        payload.source !== 'user-readonly' || payload.eligible !== true || !/^[a-f0-9]{64}$/.test(sourceFingerprint || ''))
      throw new AiError('待补任务来源不合法',400,'AI_CANDIDATE_SOURCE_FORBIDDEN');
    const [rows] = await conn.execute('SELECT * FROM ai_transaction_candidate WHERE user_id=? AND source_fingerprint=? LIMIT 1 FOR UPDATE',
      [userId,sourceFingerprint]);
    if (!rows.length) return save(userId,input,conn);
    const row=rows[0],current=unpack(row);
    if (current.draftId) return current;
    if (current.status==='discarded' || current.status==='consumed' ||
        current.status==='failed' && row.payload!=='expired')
      throw new AiError('这笔候选已结束，不能重新生成草稿',409,'AI_CANDIDATE_ENDED');
    if (row.payload!=='expired') {
      if(current.pendingTaskId!==payload.pendingTaskId || current.pendingTaskIndex!==payload.pendingTaskIndex ||
          current.conversationId!==payload.conversationId || current.originalText!==payload.originalText ||
          ['amount','direction','currency','transDate'].some(key=>current.fields[key]!==payload.fields[key]))
        throw new AiError('待补来源与原候选不一致，请核对原卡片',409,'AI_PENDING_CONFLICT');
      if(current.expiresAt>stamp() && current.pendingTaskRevision===payload.pendingTaskRevision) return current;
    }
    const restored=row.payload==='expired'?payload:Object.fromEntries(Object.entries(current).filter(([key])=>
      !['id','sourceCandidateId','status','draftId','expiresAt','inputDigest'].includes(key)));
    if(current.pendingTaskRevision!==payload.pendingTaskRevision) restored.fields={...payload.fields};
    restored.pendingTaskRevision=payload.pendingTaskRevision;
    const serialized=JSON.stringify(restored),inputDigest=digestInput(restored),expiresAt=stamp()+ttl;
    const [updated]=await conn.execute("UPDATE ai_transaction_candidate SET payload=?,input_digest=?,expires_at=?,status='pending' WHERE user_id=? AND id=? AND draft_id IS NULL AND status IN ('pending','failed')",
      [encryptField(serialized),inputDigest,expiresAt,userId,current.id]);
    if(updated.affectedRows!==1) throw new AiError('候选已变化，请读取原卡片',409,'AI_CANDIDATE_CONFLICT');
    return {...restored,id:current.id,sourceCandidateId:current.id,status:'pending',draftId:null,expiresAt,inputDigest};
  }
  async function findByRequestId(userId,requestId) {
    if(typeof userId!=='string'||!userId||userId.length>64||!uuid(requestId))
      throw new AiError('候选请求编号不合法',400,'AI_CANDIDATE_INVALID');
    const [rows]=await executor.execute(
      'SELECT * FROM ai_transaction_candidate WHERE user_id=? AND request_id=? LIMIT 1',[userId,requestId]
    );
    if(!rows[0]) return null;
    // Lookup only. Ended/expired request tombstones never authorize a rerun.
    // A consumed candidate retains its existing draft link after expiry; the
    // caller must independently load that draft with the authenticated owner.
    const value=unpack(rows[0]);
    return {...value,requestId:rows[0].request_id,
      ...(value.status!=='consumed'&&value.expiresAt<=stamp()?{status:'expired'}:{})};
  }
  async function consume(userId,id,draftId,conn) {
    const [result]=await conn.execute("UPDATE ai_transaction_candidate SET status='consumed',draft_id=? WHERE user_id=? AND id=? AND status='pending' AND expires_at>?",[draftId,userId,id,stamp()]);
    if(result.affectedRows!==1) throw new AiError('候选已使用或过期，请读取原卡片',409,'AI_CANDIDATE_CONFLICT');
  }
  async function supplement(userId,id,expectedDigest,fields,entry,conn=executor) {
    const current=await get(userId,id,conn);
    if(current.status!=='pending'||current.draftId||current.source!=='user-readonly'||current.eligible!==true||current.inputDigest!==expectedDigest)
      throw new AiError('候选状态已变化，请读取原卡片后重新补充',409,'AI_CANDIDATE_CONFLICT');
    const protectedKeys=['amount','direction','currency','transDate','remark'];
    if(protectedKeys.some(key=>fields[key]!==current.fields[key])||Object.keys(fields).some(key=>
      !Object.hasOwn(current.fields,key)&&!['accountId','categoryId','payMethod'].includes(key)))
      throw new AiError('聊天补充不能改变来源金额、方向或日期',400,'AI_CONTINUATION_INPUT_INVALID');
    const {id:_id,sourceCandidateId,status,draftId,expiresAt,inputDigest,...payload}=current;
    payload.fields={...fields};payload.trace=[...(current.trace||[]).slice(-19),entry];
    const serialized=JSON.stringify(payload);
    if(Buffer.byteLength(serialized)>64*1024||/data:image\/|"dataUrl"\s*:/.test(serialized))
      throw new AiError('候选内容过大或包含图片',400,'AI_CANDIDATE_INVALID');
    const nextDigest=digestInput(payload);
    const [updated]=await conn.execute(`UPDATE ai_transaction_candidate SET payload=?,input_digest=?
      WHERE user_id=? AND id=? AND input_digest=? AND status='pending' AND draft_id IS NULL AND expires_at>? AND source='user-readonly'`,
      [encryptField(serialized),nextDigest,userId,id,expectedDigest,stamp()]);
    if(updated.affectedRows!==1)throw new AiError('候选已使用或发生变化，请读取原卡片',409,'AI_CANDIDATE_CONFLICT');
    return get(userId,id,conn);
  }
  async function discard(userId,id) {
    const value=await get(userId,id,executor,{allowEnded:true});
    if(value.status==='discarded') return {sourceCandidateId:id,cancelled:true};
    if(value.status==='consumed') throw new AiError('此候选已生成草稿，请取消原草稿',409,'AI_CANDIDATE_CONSUMED');
    const [updated]=await executor.execute("UPDATE ai_transaction_candidate SET status='discarded' WHERE user_id=? AND id=? AND status='pending'",[userId,id]);
    if(updated.affectedRows!==1) {
      const current=await get(userId,id,executor,{allowEnded:true});
      if(current.status==='consumed') throw new AiError('此候选已生成草稿，请取消原草稿',409,'AI_CANDIDATE_CONSUMED');
      if(current.status!=='discarded') throw new AiError('候选状态已变化，请读取最新卡片',409,'AI_CANDIDATE_CONFLICT');
    }
    return {sourceCandidateId:id,cancelled:true};
  }
  return {save,get,findByFingerprint,findByRequestId,consume,discard,supplement,restorePending};
}
module.exports={createTransactionCandidateStore};
