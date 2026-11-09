import { createCipheriv } from 'node:crypto';
export const recoveryUser = '10000000-0000-0000-0000-000000000001';
export const recoveryMember = '10000000-0000-0000-0000-000000000002';
export const recoveryRemoved = '10000000-0000-0000-0000-000000000003';
export function recoveryFixture(key) {
  const iv=Buffer.alloc(12,7), cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);
  const mail={to:'recovery-only@example.test',subject:'Recovery fixture',text:'Private fixture token, never log'};
  const bytes=Buffer.concat([cipher.update(JSON.stringify(mail)),cipher.final()]);
  const payload=Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');
  return `
INSERT INTO users(id,email,password_hash,role,activation_exempt,auth_version)
 SELECT '${recoveryUser}','fixture.recovery@example.test',password_hash,'USER',true,7 FROM users LIMIT 1;
INSERT INTO applications(id,user_id,character_name,character_key,status,class_override,armory_class)
 VALUES ('${recoveryMember}','${recoveryUser}','Recovery Member','recovery member','JOINED','MAGE','WARRIOR');
INSERT INTO users(id,email,password_hash,role,email_verified_at,auth_version)
 SELECT '10000000-0000-0000-0000-000000000004','removed.recovery@example.test',password_hash,'USER',now(),2 FROM users LIMIT 1;
INSERT INTO applications(id,user_id,character_name,character_key,status)
 VALUES ('${recoveryRemoved}','10000000-0000-0000-0000-000000000004','Removed Member','removed member','JOINED');
UPDATE applications SET status='REMOVED' WHERE id='${recoveryRemoved}';
INSERT INTO events(application_id,actor_id,from_status,to_status,method)
 VALUES ('${recoveryRemoved}','${recoveryUser}','JOINED','REMOVED','MANUAL'),
 ('${recoveryRemoved}','${recoveryUser}','REMOVED','JOINED','MANUAL'),
 ('${recoveryRemoved}','${recoveryUser}','JOINED','REMOVED','MANUAL');
UPDATE roster_slots SET application_id='${recoveryMember}' WHERE position=0;
UPDATE rosters SET revision=9;
UPDATE class_jobs SET attempts=3,available_at='2100-01-01',lease_token='10000000-0000-0000-0000-000000000005',lease_until='2100-01-02';
INSERT INTO email_tokens(id,user_id,purpose,digest,expires_at)
 VALUES ('10000000-0000-0000-0000-000000000006','${recoveryUser}','VERIFY',repeat('1',64),'2100-01-01'),
 ('10000000-0000-0000-0000-000000000007','${recoveryUser}','RESET',repeat('2',64),'2100-01-01');
INSERT INTO email_jobs(user_id,token_id,payload,expires_at,available_at,attempts)
 VALUES ('${recoveryUser}','10000000-0000-0000-0000-000000000006','${payload}','2100-01-01','2100-01-01',2);
INSERT INTO email_limits(key,attempts,reset_at) VALUES (repeat('3',64),3,'2100-01-01');
INSERT INTO sessions(sid,sess,expire) VALUES ('recovery-version-seven','{"userId":"${recoveryUser}","authVersion":7,"cookie":{"secure":true}}','2100-01-01');
`;
}
