local _tonumber = tonumber
local sessionId  = ARGV[1]
local clientInitEventId  = ARGV[2]
local serverInitConfirm , serverInitEventId

local rk = {
	session 			= "sessions|"..sessionId,
	tickSessions		= "tick|sessions"
}

--check if session is set to destroyed
if(redis.call('hexists', rk.session, 'destroyed') == 1) then
	return redis.error_reply('NO SESSION - destroyed')
end

serverInitConfirm = redis.call('hget', rk.session, 'initConfirm')
serverInitEventId = redis.call('hget', rk.session, 'initEventId')

--check if session is already confirmed
if(serverInitConfirm and serverInitConfirm == clientInitEventId) then
	return redis.status_reply('OK')
end

if(serverInitEventId == clientInitEventId) then
	if(redis.call('hset', rk.session, 'initConfirm', clientInitEventId)) then
		return redis.status_reply('OK')
	end
	return redis.error_reply('INVALID INIT CONFIRM - NOT SET')
end

return redis.error_reply('INVALID INIT CONFIRM')
