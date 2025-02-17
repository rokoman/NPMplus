const _      = require('lodash');
const fs     = require('fs');
const logger = require('../logger').nginx;
const config = require('../lib/config');
const utils  = require('../lib/utils');
const error  = require('../lib/error');

const NgxPidFilePath = '/usr/local/nginx/logs/nginx.pid';

const internalNginx = {

	/**
	 * This will:
	 * - test the nginx config first to make sure it's OK
	 * - create / recreate the config for the host
	 * - test again
	 * - IF OK:  update the meta with online status
	 * - IF BAD: update the meta with offline status and remove the config entirely
	 * - then reload nginx
	 *
	 * @param   {Object|String}  model
	 * @param   {String}         host_type
	 * @param   {Object}         host
	 * @returns {Promise}
	 */
	configure: (model, host_type, host) => {
		let combined_meta = {};

		return internalNginx.test()
			.then(() => {
				// Nginx is OK
				// We're deleting this config regardless.
				// Don't throw errors, as the file may not exist at all
				// Delete the .err file too
				return internalNginx.deleteConfig(host_type, host, false, true);
			})
			.then(() => {
				return internalNginx.generateConfig(host_type, host);
			})
			.then(() => {
				// Test nginx again and update meta with result
				return internalNginx.test()
					.then(() => {
						// nginx is ok
						combined_meta = _.assign({}, host.meta, {
							nginx_online: true,
							nginx_err:    null
						});

						return model
							.query()
							.where('id', host.id)
							.patch({
								meta: combined_meta
							});
					})
					.catch((err) => {
						// Remove the error_log line because it's a docker-ism false positive that doesn't need to be reported.
						// It will always look like this:
						//   nginx: [alert] could not open error log file: open() "/dev/null" failed (6: No such device or address)

						let valid_lines = [];
						let err_lines   = err.message.split('\n');
						err_lines.map(function (line) {
							if (line.indexOf('/dev/null') === -1) {
								valid_lines.push(line);
							}
						});

						if (config.debug()) {
							logger.error('Nginx test failed:', valid_lines.join('\n'));
						}

						// config is bad, update meta and delete config
						combined_meta = _.assign({}, host.meta, {
							nginx_online: false,
							nginx_err:    valid_lines.join('\n')
						});

						return model
							.query()
							.where('id', host.id)
							.patch({
								meta: combined_meta
							})
							.then(() => {
								internalNginx.renameConfigAsError(host_type, host);
							})
							.then(() => {
								return internalNginx.deleteConfig(host_type, host, true);
							});
					});
			})
			.then(() => {
				return internalNginx.reload();
			})
			.then(() => {
				return combined_meta;
			});
	},

	/**
	 * @returns {Promise}
	 */
	test: () => {
		if (config.debug()) {
			logger.info('Testing Nginx configuration');
		}

		return utils.exec('nginx -tq');
	},

	/**
	 * @returns {Promise}
	 */

	reload: () => {
		return internalNginx.test()
			.then(() => {
				if (fs.existsSync(NgxPidFilePath)) {
					const ngxPID = fs.readFileSync(NgxPidFilePath, 'utf8').trim();
					if (ngxPID.length > 0) {
						logger.info('Reloading Nginx');
						utils.exec('nginx -s reload');
					} else {
						logger.info('Starting Nginx');
						utils.execfg('nginx -e stderr');
					}
				} else {
					logger.info('Starting Nginx');
					utils.execfg('nginx -e stderr');
				}
			});
	},

	/**
	 * @param   {String}  host_type
	 * @param   {Integer} host_id
	 * @returns {String}
	 */
	getConfigName: (host_type, host_id) => {
		if (host_type === 'default') {
			return '/data/nginx/default.conf';
		}
		return '/data/nginx/' + internalNginx.getFileFriendlyHostType(host_type) + '/' + host_id + '.conf';
	},

	/**
	 * Generates custom locations
	 * @param   {Object}  host
	 * @returns {Promise}
	 */
	renderLocations: (host) => {
		return new Promise((resolve, reject) => {
			let template;

			try {
				template = fs.readFileSync(__dirname + '/../templates/_location.conf', {encoding: 'utf8'});
			} catch (err) {
				reject(new error.ConfigurationError(err.message));
				return;
			}

			const renderEngine    = utils.getRenderEngine();
			let renderedLocations = '';

			const locationRendering = async () => {
				for (let i = 0; i < host.locations.length; i++) {
					let locationCopy = Object.assign({}, {access_list_id: host.access_list_id}, {certificate_id: host.certificate_id},
						{ssl_forced: host.ssl_forced}, {caching_enabled: host.caching_enabled}, {block_exploits: host.block_exploits},
						{allow_websocket_upgrade: host.allow_websocket_upgrade}, {http2_support: host.http2_support},
						{hsts_enabled: host.hsts_enabled}, {hsts_subdomains: host.hsts_subdomains}, {access_list: host.access_list},
						{certificate: host.certificate}, host.locations[i]);

					if (locationCopy.forward_host.indexOf('/') > -1) {
						const split = locationCopy.forward_host.split('/');

						locationCopy.forward_host = split.shift();
						locationCopy.forward_path = `/${split.join('/')}`;
					}

					// eslint-disable-next-line
					renderedLocations += await renderEngine.parseAndRender(template, locationCopy);
				}

			};

			locationRendering().then(() => resolve(renderedLocations));

		});
	},

	/**
	 * @param   {String}  host_type
	 * @param   {Object}  host
	 * @returns {Promise}
	 */
	generateConfig: (host_type, host) => {
		const nice_host_type = internalNginx.getFileFriendlyHostType(host_type);

		if (config.debug()) {
			logger.info('Generating ' + nice_host_type + ' Config:', JSON.stringify(host, null, 2));
		}

		const renderEngine = utils.getRenderEngine();

		return new Promise((resolve, reject) => {
			let template = null;
			let filename = internalNginx.getConfigName(nice_host_type, host.id);

			try {
				template = fs.readFileSync(__dirname + '/../templates/' + nice_host_type + '.conf', {encoding: 'utf8'});
			} catch (err) {
				reject(new error.ConfigurationError(err.message));
				return;
			}

			let locationsPromise;
			let origLocations;

			// Manipulate the data a bit before sending it to the template
			if (nice_host_type !== 'default') {
				host.use_default_location = true;
				if (typeof host.advanced_config !== 'undefined' && host.advanced_config) {
					host.use_default_location = !internalNginx.advancedConfigHasDefaultLocation(host.advanced_config);
				}
			}

			if (host.locations) {
				//logger.info ('host.locations = ' + JSON.stringify(host.locations, null, 2));
				origLocations    = [].concat(host.locations);
				locationsPromise = internalNginx.renderLocations(host).then((renderedLocations) => {
					host.locations = renderedLocations;
				});

				// Allow someone who is using / custom location path to use it, and skip the default / location
				_.map(host.locations, (location) => {
					if (location.path === '/') {
						host.use_default_location = false;
					}
				});

			} else {
				locationsPromise = Promise.resolve();
			}

			// Set the IPv6 setting for the host
			host.ipv6 = internalNginx.ipv6Enabled();

			locationsPromise.then(() => {
				renderEngine
					.parseAndRender(template, host)
					.then((config_text) => {
						fs.writeFileSync(filename, config_text, {encoding: 'utf8'});

						if (config.debug()) {
							logger.success('Wrote config:', filename, config_text);
						}

						// Restore locations array
						host.locations = origLocations;

						resolve(true);
					})
					.catch((err) => {
						if (config.debug()) {
							logger.warn('Could not write ' + filename + ':', err.message);
						}

						reject(new error.ConfigurationError(err.message));
					});
			});
		});
	},

	/**
	 * A simple wrapper around unlinkSync that writes to the logger
	 *
	 * @param   {String}  filename
	 */
	deleteFile: (filename) => {
		logger.debug('Deleting file: ' + filename);
		try {
			fs.unlinkSync(filename);
		} catch (err) {
			logger.debug('Could not delete file:', JSON.stringify(err, null, 2));
		}
	},

	/**
	 *
	 * @param   {String} host_type
	 * @returns String
	 */
	getFileFriendlyHostType: (host_type) => {
		return host_type.replace(new RegExp('-', 'g'), '_');
	},


	/**
	 * @param   {String}  host_type
	 * @param   {Object}  [host]
	 * @param   {Boolean} [delete_err_file]
	 * @returns {Promise}
	 */
	deleteConfig: (host_type, host, delete_err_file) => {
		const config_file     = internalNginx.getConfigName(internalNginx.getFileFriendlyHostType(host_type), typeof host === 'undefined' ? 0 : host.id);
		const config_file_err = config_file + '.err';

		return new Promise((resolve/*, reject*/) => {
			internalNginx.deleteFile(config_file);
			if (delete_err_file) {
				internalNginx.deleteFile(config_file_err);
			}
			resolve();
		});
	},

	/**
	 * @param   {String}  host_type
	 * @param   {Object}  [host]
	 * @returns {Promise}
	 */
	renameConfigAsError: (host_type, host) => {
		const config_file     = internalNginx.getConfigName(internalNginx.getFileFriendlyHostType(host_type), typeof host === 'undefined' ? 0 : host.id);
		const config_file_err = config_file + '.err';

		return new Promise((resolve/*, reject*/) => {
			fs.unlink(config_file, () => {
				// ignore result, continue
				fs.rename(config_file, config_file_err, () => {
					// also ignore result, as this is a debugging informative file anyway
					resolve();
				});
			});
		});
	},

	/**
	 * @param   {String}  host_type
	 * @param   {Array}   hosts
	 * @returns {Promise}
	 */
	bulkGenerateConfigs: (host_type, hosts) => {
		let promises = [];
		hosts.map(function (host) {
			promises.push(internalNginx.generateConfig(host_type, host));
		});

		return Promise.all(promises);
	},

	/**
	 * @param   {String}  host_type
	 * @param   {Array}   hosts
	 * @returns {Promise}
	 */
	bulkDeleteConfigs: (host_type, hosts) => {
		let promises = [];
		hosts.map(function (host) {
			promises.push(internalNginx.deleteConfig(host_type, host, true));
		});

		return Promise.all(promises);
	},

	/**
	 * @param   {string}  config
	 * @returns {boolean}
	 */
	advancedConfigHasDefaultLocation: function (cfg) {
		return !!cfg.match(/^(?:.*;)?\s*?location\s*?\/\s*?{/im);
	},

	/**
	 * @returns {boolean}
	 */
	ipv6Enabled: function () {
		if (typeof process.env.DISABLE_IPV6 !== 'undefined') {
			const disabled = process.env.DISABLE_IPV6.toLowerCase();
			return !(disabled === 'on' || disabled === 'true' || disabled === '1' || disabled === 'yes');
		}

		return true;
	}
};

module.exports = internalNginx;
