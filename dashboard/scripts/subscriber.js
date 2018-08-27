"use strict"
const net 			= require('net')
const EventEmitter 	= require('events')
const request 		= require('request')
const debug         = require('debug')      //https://github.com/visionmedia/debug
const _log          = debug('sub_client')
const _error        = debug('bot')
const config  = require('../../../../includes/env.json')[process.env.NODE_ENV || 'development']
class SubEmitter extends EventEmitter {}
const roomActions 	= require('../../scripts/room/shared')
const helper = require("../../utils/helpers")

const filteredArray = (arr) => arr.filter(function(item, pos){
	return arr.indexOf(item)=== pos
})

function SubClient(data){
	const clientEmitter = new SubEmitter()
	const client = new net.Socket()
	clientEmitter.state = "init"

	// Set up a client and connect to port 31337 (or whatever port you use)
	client.connect({ port: config['TCP_SERVER_PORT']},
		function() {
			clientEmitter.rooms = []
			clientEmitter.reserves = []
			// Send some data
			clientEmitter.userData = data
			client.write(`__INIT__${JSON.stringify(data)}__ENDINIT__`)
		}
	)

	// When data is returned from server
	client.on('data', function(dataRaw) {
		if(clientEmitter.state === "disconnecting") return

		//Unlike init, we start from beginning of buffer
		let jsonStart = dataRaw.indexOf('__JSON__START__')
		let jsonEnd = dataRaw.indexOf('__JSON__END__')

		if (jsonStart !== -1 && jsonEnd !== -1) {
			let bufStr = dataRaw.toString('utf8', jsonStart + 15, jsonEnd)

			let response = bufStr && helper._isJson(bufStr) ? JSON.parse(bufStr) : {}
			let phase = (response && response.phase) ? response.phase : false
			let eventId = (response && response.eventId) ? response.eventId : false


			//Determine route based on phase
			//console.log('emitting', phase, response)
			clientEmitter.emit(phase, response)

			if(eventId){
				clientEmitter.publish({
					intent: "eventConfirm",
					eventId: eventId
				})
			}
		}
	})

	client.on('error', function(err) {
		_error('[ERROR BOT]' + err.status, err.message)
		console.log(err, err.stack.split("\n"))
		client.end(err.toString())
	})

	clientEmitter.on('init', function(data){
		clientEmitter.state = "ready"
		clientEmitter.sessionId = data.response.sessionId

		if(clientEmitter.keepAliveTimer){
			clearInterval(clientEmitter.keepAliveTimer)
		}

		clientEmitter.keepAliveTimer = setInterval(() => {
			const dataToSend = {
				intent: "keepAlive",
				params:{
					startPing:Date.now()
				}
			}
			return clientEmitter.publish(dataToSend)
		},30000)
	})

	clientEmitter.on('reservation', function(data){
		if(data){
			clientEmitter.reserves.push(data.roomName)
			filteredArray(clientEmitter.reserves)

		} else {
			_log('[Bot] err on reservation', data)
		}
	})

	clientEmitter.on('subscribed', function(data){
		//remove duplicates
		clientEmitter.rooms.push(data.room)
		filteredArray(clientEmitter.rooms)
	})

	clientEmitter.on('requestDisconnect', function(data){
		_log('Requesting dc for ',clientEmitter.sessionId, data, (Date.now() - data.response.time))
		if(data.response && data.response.sessionId === clientEmitter.sessionId && data.room){

			//check if time is within a timeframe
			const validTime = (Date.now() - data.response.time) <= 10000

			if(validTime){
				clientEmitter.disconnect()
			} else {
				_log('time limit reached for dc request')
			}
		} else {
			_log('err on disconnect')
		}
	})


	clientEmitter.publish = (message) => {
		if(clientEmitter.state === "disconnecting") return
		const jsonMsg = JSON.stringify(message)
		client.write(`__JSON__START__${jsonMsg}__JSON__END__`)
	}

	clientEmitter.findAndReserveRoom = (roomPath, params = {}) => {
		if(clientEmitter.state === "disconnecting") return

		const dataToSend = {
			sessionId: clientEmitter.sessionId,
			userId:	clientEmitter.userData.userId,
			roomName: roomPath,
			params: params,
			appName: params.appName,
			isSimulator: false,
		}
		_log('port1', config['API_PORT'])

		new request({
			method: 'POST',
			url: 'http://localhost:'+config['API_PORT']+'/api/v1/room/reserve',
			json:true,
			body: dataToSend,
		}, (err, response, resBody) => {

			if(resBody.error){
				_log('err', resBody)
			} else {
				_log('success', resBody)
				clientEmitter.emit('reservation', resBody.response)
			}
		})
	}

	clientEmitter.reserveRoom = (roomName, params = {}) => {
		if(clientEmitter.state === "disconnecting") return

		const roomArr = helper._roomNameToArr(roomName)

		const dataToSend = {
			sessionId: clientEmitter.sessionId,
			userId:	clientEmitter.userData.userId,
			roomName: roomName,
			params: params,
			appName: roomArr.roomAppName,
			isSimulator: false,
		}

		_log('port', config['API_PORT'])
		new request({
			method: 'POST',
			url: 'http://localhost:'+config['API_PORT']+'/api/v1/room/reserve',
			json:true,
			body: dataToSend,
		}, (err, response, resBody) => {

			// body is the decompressed response body
			if(err){
				_log('err bot', err, response, resBody)

				_log('error', err)
				clientEmitter.disconnect('end', err.toString())

			} else if(resBody && resBody.error){
				_log('err', resBody)
			} else {
				clientEmitter.emit('reservation', resBody.response)
				clientEmitter.requestSubscribe(resBody.response.roomName, resBody.response.params)
			}

		})

	}

	clientEmitter.requestSubscribe = (roomName, params = {}) => {
		if(clientEmitter.state === "disconnecting") return

		params.room = roomName
		const message = {
			intent: "subscribe",
			roomName:roomName,
			params: params
		}

		const jsonMsg = JSON.stringify(message)
		client.write(`__JSON__START__${jsonMsg}__JSON__END__`)
	}

	clientEmitter.requestUnsubscribe = (roomName, params = {}) => {
		const message = {
			intent: "unsubscribe",
			roomName:roomName,
			params: params
		}
		const jsonMsg = JSON.stringify(message)
		client.write(`__JSON__START__${jsonMsg}__JSON__END__`)
	}

	clientEmitter.disconnect = (type,msg) => {
		clientEmitter.state = "disconnecting"
		delete clientEmitter.rooms
		delete clientEmitter.reserves

		if(clientEmitter.sessionId){
			_log('[Bot '+clientEmitter.sessionId+"] Goodbye")
		}
		switch(type){
			case 'end':
				return client.end(msg)
			case 'destroy':
				return client.destroy(msg)
			default:
				return client.end()
		}
	}

	return clientEmitter
}

module.exports = SubClient