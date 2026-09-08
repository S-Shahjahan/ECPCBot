export const deliveryRank = { sent: 1, delivered: 2, read: 3, failed: 4 };
export async function applyReceipt(db, clientId, metaId) {
  const receipt = await db.one(
    'SELECT * FROM delivery_receipts WHERE meta_id=$1 AND client_id=$2',
    [metaId, clientId],
  );
  if (!receipt) return;
  const log = await db.one(
    'SELECT * FROM message_logs WHERE meta_id=$1 AND client_id=$2',
    [metaId, clientId],
  );
  if (!log) return;
  await db.query(
    'UPDATE delivery_receipts SET conversation_id=$1 WHERE meta_id=$2',
    [log.conversation_id, metaId],
  );
  const updated = await db.one(
    "UPDATE message_logs SET status=$1 WHERE id=$2 AND CASE status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END < $3 RETURNING id",
    [receipt.status, log.id, receipt.rank],
  );
  if (updated && receipt.status === 'failed')
    await db.query(
      "INSERT INTO alerts(id,client_id,conversation_id,kind,message) VALUES($1,$2,$3,'delivery','WhatsApp reported a delivery failure. Review the conversation and Meta account.') ON CONFLICT(id) DO NOTHING",
      ['delivery-' + log.id, clientId, log.conversation_id],
    );
}
