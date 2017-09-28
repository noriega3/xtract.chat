--Room properties
local clientRoomName 	= KEYS[1]
local currentTime           = redis.call('get', 'serverTime')

if(not currentTime) then
	return redis.error_reply('NO SERVERTIME')
end
local nextExpiration 	= currentTime+5000
local nextAvailableSeat, isDealer

local rk = {
	tickRooms      	= "tick|rooms",
	roomName       	= "rooms|"..KEYS[1],
	roomInfo       	= "rooms|"..KEYS[1].."|info",
	roomPlayers  	= "rooms|"..KEYS[1].."|players",
	roomMessages   	= "rooms|"..KEYS[1].."|messages",
}
local doesRoomExist = redis.call('exists', rk.roomName) == 1
if(not doesRoomExist) then
	return redis.error_reply('NOT EXIST')
end

local gameInfo = redis.call('hmget', rk.roomInfo, 'gameId', 'gameState', 'nextEventId', 'turnSeatIndex', 'turnExpireAt')
local gameId = gameInfo[1]
local gameState = gameInfo[2]
local gameStateId = gameInfo[3]
local seat = gameInfo[4]
local turnExpiration = tonumber(gameInfo[5])

if(not gameState or gameState ~= "ACTIVE") then
	return redis.error_reply('NOT ACTIVE')
end

--update to global room ticker with a grace period of 5 seconds
redis.call('zadd',rk.tickRooms,currentTime+5000,clientRoomName)

--set to current gameId
gameId = gameId -1

--set key
rk.roomPlayers = rk.roomPlayers..gameId

local function isSeatTaken(seatIndex)
	if(seatIndex == 5) then return true end
	local isSeatTaken = redis.call('hget', rk.roomPlayers, seatIndex)
	local isSessionAlive = redis.call('zscore', 'tick|sessions', isSeatTaken) --5 sec grace
	return isSeatTaken and isSessionAlive
end


local function getNextSeat()
	--find the next available seat that isn't the dealer(5)
	for nextSeatIndex=seat, 5 do
		nextAvailableSeat = isSeatTaken(nextSeatIndex)
		if(nextAvailableSeat or nextSeatIndex == 5) then
			nextAvailableSeat = nextSeatIndex
			isDealer = nextSeatIndex == 5
			return nextAvailableSeat
		end
	end
	return false
end

if(getNextSeat()) then
	if(isDealer) then
		redis.call('hset', rk.roomInfo, 'gameState', 'COMPLETE')
		redis.call('hincrby', rk.roomInfo, 'gamesCompleted', 1)
	else
		redis.call('hset', rk.roomInfo, 'turnSeatIndex', nextAvailableSeat)
		redis.call('hset', rk.roomInfo, 'turnExpireAt', nextExpiration)
	end

	local publishTurn = function()
		local dataToSend = {
			sessionIds = nil,
			message = {
				phase = "roomUpdate",
				room = clientRoomName,
				response = {
					--overwite or set to default some the message.response (to prevent meddling)
					room = clientRoomName,
					gameId = gameId..":"..gameStateId,
					gameState = gameState,
					turnEnded = seat,
					turnStart = nextAvailableSeat,
					turnExpiration = 5000
				}
			}
		}
		local sessionIds = {}
		local searchTerm = '[pos||is-sub-of||'..clientRoomName..'||'
		local subscribers = redis.call('zrangebylex', 'hex|sessions:rooms', searchTerm, searchTerm..'\xff')

		for x=1, #subscribers do
			sessionIds[x] = subscribers[x]:sub(#searchTerm)
		end

		--set sessionIds to list of ids in the room
		dataToSend.sessionIds = sessionIds

		--encode message and sessionId(s) for redis
		local encoded = cjson.encode(dataToSend)

		--increment message id
		local nextId = redis.call('hincrby', rk.roomInfo, "nextMessageId", 1)

		--send user connecting to room message list to be processed by room queue
		redis.call('zadd', rk.roomMessages, nextId, cjson.encode(dataToSend.message))

		--https://redis.io/commands/eval#available-libraries
		redis.call('publish', rk.roomName, encoded)

		--return the sub message to retry if failure
		return cjson.encode(dataToSend.message)
	end

	publishTurn()
end




return redis.status_reply('OK')
