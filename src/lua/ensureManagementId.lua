local key = KEYS[1]
local expectedOwner = ARGV[1]
local candidate = ARGV[2]
local kind = redis.call('TYPE', key).ok
if kind == 'none' then return false end
if kind ~= 'hash' then return redis.error_reply('wrong type for session key') end
if redis.call('HGET', key, 'userId') ~= expectedOwner then
  return redis.error_reply('session owner mismatch')
end
local current = redis.call('HGET', key, 'managementId')
if current then return current end
redis.call('HSETNX', key, 'managementId', candidate)
return redis.call('HGET', key, 'managementId')
