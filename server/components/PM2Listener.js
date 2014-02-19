var Autowire = require("wantsit").Autowire,
	EventEmitter = require("wildemitter"),
	util = require("util"),
	defaults = require("defaults");

var DEFAULT_DEBUG_PORT = 5858;

var PM2Listener = function() {
	EventEmitter.call(this);

	this._config = Autowire;
	this._logger = Autowire;
	this._pm2InterfaceFactory = Autowire;

	this._pm2List = {};
}
util.inherits(PM2Listener, EventEmitter);

PM2Listener.prototype.afterPropertiesSet = function() {
	this._config.get("pm2").forEach(function(pm2Details) {
		this._connect(pm2Details);
	}.bind(this));
}

PM2Listener.prototype.close = function() {
	Object.keys(this._pm2List).forEach(function(key) {
		this._pm2List[key].disconnect();
	}.bind(this));
}

PM2Listener.prototype._connect = function(pm2Details) {
	this._logger.debug("PM2Listener", "Connecting to", pm2Details.host, "RPC port", pm2Details.rpc, "Event port", pm2Details.events);

	var remote = this._pm2InterfaceFactory({
		sub_port: pm2Details.events,
		rpc_port: pm2Details.rpc,
		bind_host: pm2Details.host
	});

	remote.on("ready", this._pm2RPCSocketReady.bind(this, remote, pm2Details));
	remote.on("closed", this._pm2RPCSocketClosed.bind(this, remote));
	remote.on("close", this._pm2EventSocketClosed.bind(this, remote));
	remote.on("reconnecting", this._pm2EventSocketReconnecting.bind(this, remote));
}

PM2Listener.prototype._pm2RPCSocketReady = function(pm2Interface, pm2Details) {
	if(this._pm2List[pm2Interface.bind_host]) {
		return;
	}

	this._logger.info("PM2Listener", pm2Interface.bind_host, "RPC socket ready");

	// listen for all events
	pm2Interface.bus.on("*", function(event, data) {
		data.name = pm2Interface.bind_host;
		this.emit(event, data);
	}.bind(this));

	var getSystemData = function() {
		pm2Interface.rpc.getSystemData({}, function(error, data) {
			if(error) {
				this._logger.warn("PM2Listener", "Error retrieving system data", error.message);
			} else {
				// only expose fields we are interested in
				var systemData = this._mapSystemData(pm2Interface, data, pm2Details);

				this.emit("systemData", systemData);
			}

			setTimeout(getSystemData, this._config.get("updateFrequency"));
		}.bind(this));
	}.bind(this);
	getSystemData();

	this._pm2List[pm2Interface.bind_host] = pm2Interface;
}

PM2Listener.prototype._mapSystemData = function(pm2Interface, data, pm2Details) {
	// support for pm2 < 0.7.2
	if(!data.system.time) {
		data.system.time = Date.now();
	}

	var systemData = {
		name: pm2Interface.bind_host,
		inspector: pm2Details.inspector,
		system: {
			hostname: data.system.hostname,
			cpu_count: data.system.cpus.length,
			load: [
				data.system.load[0],
				data.system.load[1],
				data.system.load[2]
			],
			uptime: data.system.uptime,
			memory: {
				free: data.system.memory.free,
				total: data.system.memory.total
			},
			time: data.system.time
		},
		processes: []
	};

	var reloading = [];

	data.processes.forEach(function(process) {
		if((typeof process.pm_id == "string" || process.pm_id instanceof String) && process.pm_id.substring(0, 8) == "todelete") {
			// process has been reloaded - this is the old process that will be killed
			// so record that it's reloading but do not create a duplicate process for it.
			reloading.push(parseInt(process.pm_id.substring(8), 10));

			return;
		}

		if(process.pm2_env.status != "online" && process.pm2_env.status != "stopped" && process.pm2_env.status != "errored" && process.pm2_env.status != "launching") {
			this._logger.warn("Unknown status!", process.pm2_env.status);
		}

		systemData.processes.push({
			id: process.pm_id,
			pid: process.pid,
			name: process.pm2_env.name,
			script: process.pm2_env.pm_exec_path,
			uptime: (data.system.time - process.pm2_env.pm_uptime) / 1000,
			restarts: process.pm2_env.restart_time,
			status: process.pm2_env.status,
			memory: process.monit.memory,
			cpu: process.monit.cpu,
			debugPort: this._findDebugPort(process.pm2_env.execArgv)
		});
	}.bind(this));

	// mark processes that are reloading as such
	systemData.processes.forEach(function(process) {
		process.reloading = reloading.indexOf(process.id) != -1;
	});

	return systemData;
}

PM2Listener.prototype._pm2RPCSocketClosed = function(pm2Interface) {
	this._logger.info("PM2Listener", pm2Interface.bind_host, "RPC socket closed");

	delete this._pm2List[pm2Interface.bind_host];
}

PM2Listener.prototype._pm2EventSocketClosed = function(pm2Interface) {
	this._logger.info("PM2Listener", pm2Interface.bind_host, "event socket close");
}

PM2Listener.prototype._pm2EventSocketReconnecting = function(pm2Interface) {
	this._logger.info("PM2Listener", pm2Interface.bind_host, "event socket reconnecting");
}

PM2Listener.prototype.stopProcess = function(host, pm_id) {
	this._doByProcessId(host, pm_id, "stopProcessId");
}

PM2Listener.prototype.startProcess = function(host, pm_id) {
	this._doByProcessId(host, pm_id, "startProcessId");
}

PM2Listener.prototype.restartProcess = function(host, pm_id) {
	this._doByProcessId(host, pm_id, "restartProcessId");
}

PM2Listener.prototype.reloadProcess = function(host, pm_id) {
	if(this._config.get("forceHardReload")) {
		this._doByProcessId(host, pm_id, "reloadProcessId");
	} else {
		this._doByProcessId(host, pm_id, "softReloadProcessId");
	}
}

PM2Listener.prototype.debugProcess = function(host, pm_id) {
	// put the remot process into debug mode
	this._pm2List[host].rpc.sendSignalToProcessId({
		process_id: pm_id,
		signal: "SIGUSR1"
	}, function(error) {

	});
};

PM2Listener.prototype._doByProcessId = function(host, pm_id, action) {
	if(!this._pm2List[host]) {
		return this._logger.info("PM2Listener", "Invalid host", host, "not in", Object.keys(this._pm2List));
	}

	this._logger.info("PM2Listener", host, pm_id, action);
	this._pm2List[host].rpc[action](pm_id, function(error) {

	});
}

PM2Listener.prototype._findDebugPort = function(execArgv) {
	var port = DEFAULT_DEBUG_PORT;

	if(Array.isArray(execArgv)) {
		execArgv.forEach(function(argument) {
			if(argument.match(/--debug=[0-9]+/)) {
				port = parseInt(argument.split("=")[1], 10);
			}

			if(argument.match(/--debug-brk=[0-9]+/)) {
				port = parseInt(argument.split("=")[1], 10);
			}
		});
	}

	return port;
}

module.exports = PM2Listener;