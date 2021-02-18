#!/usr/bin/node
const logger = require('logger').get('dal');
const db = require('./db-connect');
const snowmachine = new (require('snowflake-generator'))(1420070400000);
const Long = require('long');
// magic number comes from https://discord.com/developers/docs/reference#snowflakes-snowflake-id-format-structure-left-to-right
// represents the Discord Epoch, in 2015 or something

// cassandra-driver:
// https://docs.datastax.com/en/developer/nodejs-driver/4.6/api/class.Client/

class Schema {
	constructor(name, keys = [], requireds = [], nullables = [], immutables = [], automatics = [], update_keys = [], typeSamples = {}, validators = [], permitNulls = false) {
		// e.g. 'guilds', 'channels_by_guild'
		// this is used as a table name for generating CQL
		this.name = name;
		// list of all column names
		this.keys = keys;
		// list of all columns who must be specified in any query:
		// both new records and updates to existing records _must_
		// have these keys. this is NOT an exhaustive list of all keys
		// that must never be left null. see nullables
		this.requireds = requireds;
		// list of all columns whose values are not mandatory (may be
		// omitted when the record is created)
		// this list takes part in automatic validation
		this.nullables = nullables;
		// list of all columns whose values are immutable once a row has
		// been written
		this.immutables = immutables;
		// list of all columns whose values are generated by code in this
		// file, rather than supplied by the user/other areas of the
		// application
		// (e.g. snowflakes are generated here when a record is created)
		this.automatics = automatics;
		// list of all columns used to identify rows to be updated
		// used by this.getUpdateStmt
		this.update_keys = update_keys;
		// collection of type samples for type validation
		this.typeSamples = typeSamples;
		// list of functions that validate a schema
		// each function takes an object (proposed record) and a boolean
		// (whether to treat the object as a new record or a set of updates)
		// if the object is treated as a set of updates, some fields may be
		// omitted, whereas a new record must have all fields specified
		// (unless the record is okay with leaving things empty)
		// each function returns an array of zero or more strings, each of
		// which describes an error with the input
		this.validators = validators;
		// whether or not to ever permit a key to have a null value
		this.permitNulls = permitNulls;

		this.validators.push(Schema.getCheckForMissingKeys(this));
		this.validators.push(Schema.getCheckForTypeErrors(this));
	}

	trim(obj) {
		const out = {};
		this.keys.forEach(key => {out[key] = obj[key];});
		Object.keys(out).forEach(key => {
			if (out[key] === undefined) delete out[key];
		});
		return out;
	}

	validate(obj, isUpdate = false) {
		const errors = [];
		this.validators.forEach(v => {
			errors.push(...v(obj, isUpdate));
		});
		return errors;
	}

	get updatables() {
		return this.keys.filter(key => !this.immutables.includes(key));
	}

	getInsertStmt(record) {
		record = this.trim(record);
		const errors = this.validate(record, false);
		if (errors.length) {
			throw errors;
		}

		const columns = Object.keys(record);
		const params = columns.map(key => record[key]);

		const column_string = columns.join(', ');
		const value_string = columns.map(x => '?').join(', ');

		return [
			`INSERT INTO ${this.name} (${column_string}) VALUES (${value_string});`
			, params
			, { prepare: true }
		];
	}

	getSelectStmt(criteria = '', params = []) {
		return [
			`SELECT * FROM ${this.name} ${criteria};`
			, params
			, { prepare: true }
		];
	}

	getUpdateStmt(changes) {
		changes = this.trim(changes);
		const errors = this.validate(changes, true);
		if (errors.length) {
			throw errors;
		}

		const columns = [];
		const update_keys = [];
		const params = [];
		Object.keys(changes).forEach(key => {
			if (this.immutables.includes(key))
				update_keys.push(key);
			else
				columns.push(key);
		});
		for (let key of columns) params.push(changes[key]);
		for (let key of update_keys) params.push(changes[key]);
		const column_string = columns.map(c => c + ' = ?').join(', ');
		const key_string = update_keys.map(c => c + ' = ?').join(' AND ');

		return [
			`UPDATE ${this.name} SET ${column_string} WHERE ${key_string};`
			, params
			, { prepare: true }
		];
	}

	getDeleteStmt(criteria) {
		criteria = this.trim(criteria);
		const errors = [];
		// forbid deleting based on anything mutable
		for (let key of Object.keys(criteria))
			if (this.updatables.includes(key))
				errors.push(`DELETE criteria may only be immutable columns (${this.immutables.join(', ')}), but ${key} was supplied`);
		if (errors.length) {
			throw errors;
		}

		// deletion criteria are OK, so carry on
		const columns = Object.keys(criteria);
		const params = columns.map(key => criteria[key]);

		const criteria_string = columns.map(c => c + ' = ?').join(' AND ');
		return [
			`DELETE FROM ${this.name} WHERE ${criteria_string};`
			, params
			, { prepare: true }
		];
	}

	static getCheckForMissingKeys(_this) {
		return (obj, isUpdate) => {
			const errors = [];
			if (isUpdate) {
				// check that all requireds are supplied
				for (let key of _this.requireds)
					if (obj[key] === undefined) errors.push(`Key ${key} is required for an update, but was not supplied`);
				// check that all supplied keys are not null
				for (let key of _this.keys)
					if (!_this.permitNulls && obj[key] === null) errors.push(`Key ${key} is required for an update, but null was supplied`);
				// check that at least one mutable key is supplied
				// i.e., make sure we're actually updating something
				if (_this.keys
					.filter(key => !_this.immutables.includes(key))
					.filter(key => obj[key] !== undefined)
					.length === 0)
					errors.push(`At least one key besides [${_this.immutables.join(', ')}] must be supplied for an update, but none were`);
				/*
				else console.log(_this.keys
					.filter(key => !_this.immutables.includes(key))
					.filter(key => obj[key] !== undefined)
				);
				 */
			} else {
				// ensure that all keys that aren't optional are defined,
				// and also that all keys that are defined aren't null if nulls are not permitted
				// i.e., if !permitNulls, then an optional key can be anything but null
				for (let key of _this.keys)
					if (obj[key] === undefined && !_this.nullables.includes(key)) errors.push(`Key ${key} is required for a new record, but was not supplied`);
				else if (!_this.permitNulls && obj[key] === null) errors.push(`Key ${key} must not be null, but null was supplied`);
			}
			return errors;
		}
	}

	static getCheckForTypeErrors(_this) {
		return (obj, isUpdate) => {
			const errors = [];
			for (let key of Object.keys(_this.typeSamples))
				if (obj[key] !== undefined
					&& obj[key] !== null
					&& obj[key].constructor.name !== _this.typeSamples[key].constructor.name)
					errors.push(`Key ${key} must be of type ${_this.typeSamples[key].constructor.name}, but the supplied value ${obj[key]} is of type ${obj[key].constructor.name}`);
			return errors;
		}
	}

}

// takes data from database and converts anything necessary before shipping data to users
// e.g. convert snowflakes from Long to string
const convertTypesForDistribution = (row) => {
	const out = {};
	for (let key of Object.keys(row))
		if (row[key] !== undefined && row[key] !== null)
			switch (row[key].constructor.name) {
				case 'Long': out[key] = row[key].toString(); break;
				default: out[key] = row[key];
			}
	else out[key] = row[key];
	return out;
};

// oh no, what have i done
// name, keys, requireds, nullables, immutables, automatics, update keys, type samples, validators, permit nulls
const schemas = {
	guilds: new Schema('guilds'
		, ['guild_id', 'name', 'icon_id'] // keys
		, ['guild_id'] // requireds
		, [] // nullables
		, ['guild_id'] // immutables
		, ['guild_id'] // automatics
		, ['guild_id'] // update keys
		, { // type samples
			'guild_id': new Long()
			, 'name': ''
			, 'icon_id': new Long()
		})
	, channels_by_guild: new Schema('channels_by_guild'
		, ['guild_id', 'position', 'channel_id', 'name'] // keys
		, ['guild_id'] // requireds
		, [] // nullables
		, ['guild_id', 'channel_id'] // immutables
		, ['channel_id'] // automatics
		, ['guild_id', 'channel_id'] // update keys
		, { // type samples
			'guild_id': new Long()
			, 'position': 0
			, 'channel_id': new Long()
			, 'name': ''
		}
		, [
			(record, isUpdate) => {return /^[a-z-]{1,64}$/.test(record.name) && /^[a-z]/.test(record.name) && /[a-z]$/.test(record.name) && !(/--/.test(record.name))? [] : [`Channel name must be composed only of lowercase a-z and hyphens, with no more than one consecutive hyphen, starting and ending with a letter, but ${record.name} was supplied`]}
		])
};

// adds things like 'guild_id < ?' to the list of constraints supplied
// also adds errors if appropriate
const addSnowflakeConstraint = (key, constraint_string, options, constraints, params, errors, required = false) => {
	if (options[key] === undefined || options[key] === null) {
		if (required)
			errors.push(`'${key}' must be a snowflake (either as a string or a Long), but ${options[key]} was supplied`);
		return;
	} else {
		constraints.push(`${constraint_string} ?`);
		switch (options[key].constructor.name) {
			case 'String':
			case 'Long':
				params.push(coerceToLong(options[key]));
				break;
			default:
				errors.push(`'${key}' must be a snowflake (either as a string or a Long), but ${options[key]} of type ${options[key].constructor.name} was supplied`);
		}
	}
};

const generateResultLimit = (limit, params, errors) => {
	if (limit === undefined || limit === null) return '';
	if (limit.constructor.name !== 'Number')
		errors.push(`'limit' search filter must be a Number, but ${limit} of type ${limit.constructor.name} was supplied`);
	else if (limit < 1)
		errors.push(`'limit' search filter must be a positive integer, but ${limit} was supplied`);
	else {
		params.push(limit);
		return ' LIMIT ?';
	}
};

const coerceToLong = (x) => (x === undefined || x === null) ? x : Long.fromString(x.toString());

/*
 ** guidelines for designing these methods
 ** 
 **  - all crud operations are async and may throw an array of strings that describe errors
 **   - as many errors as possible/helpful should be thrown at once
 **   - all methods should start with a type-checking block
 **  - all snowflakes should be acceptable as either strings or Longs
 **  - all snowflakes should be returned as strings
 **  - optional keys that are undefined or null should be ignored
 **  - optional keys with otherwise illegal values should throw errors
 **  - required keys that are undefined or null should throw errors
 **
 **  - create takes only mandatory parameters, no options object
 **  - read takes mandatory parameters and an options object
 **  - update takes mandatory parameters and an options object
 **  - delete takes only mandatory parameters, no options object
 **
 */

/*************************************************************************
 * guilds
 */
// returns description of guild, or throws
const createGuild = async (name, icon_snowflake) => {
	const errors = [];
	if (name === undefined || name === null)
		errors.push(`A name must be passed, but ${name} was supplied`);
	else name = name.toString();
	if (icon_snowflake === undefined || icon_snowflake === null)
		errors.push(`An icon snowflake must be passed, but ${icon_snowflake} was supplied`);
	else icon_snowflake = coerceToLong(icon_snowflake);
	if (errors.length) {
		throw errors;
	}

	const record = {
		guild_id: coerceToLong(snowmachine.generate().snowflake)
		, name
		, icon_id: icon_snowflake
	};

	return db.execute(...schemas.guilds.getInsertStmt(record))
		.then(() => convertTypesForDistribution(record));
};

// returns list of guild descriptions, or throws
const getGuilds = async (options = {
	guild_id: undefined
	, limit: undefined
}) => {
	if (options === null) options = {};
	const keys = Object.keys(options);
	const constraints = [];
	let limit = '';
	const params = [];
	const errors = [];

	addSnowflakeConstraint('guild_id', 'guild_id =', options, constraints, params, errors);
	limit = generateResultLimit(options.limit, params, errors);

	if (errors.length) {
		throw errors;
	}

	let opt_string = '';
	if (constraints.length) opt_string = 'WHERE ';
	opt_string += constraints.join(' AND ');
	opt_string += limit;

	return db.execute(...schemas.guilds.getSelectStmt(opt_string, params))
		.then(res => res.rows)
		.then(rows => rows.map(convertTypesForDistribution))
	;
};

// returns or throws
// FIXME this is currently an expensive operation, with three queries total
// try to reduce this, eh?
const updateGuild = async (guild_snowflake, changes) => {
	const errors = [];
	if (guild_snowflake === undefined || guild_snowflake === null)
		errors.push(`A guild snowflake must be passed, but ${guild_snowflake} was supplied`);
	else guild_snowflake = coerceToLong(guild_snowflake);
	if (changes === undefined || changes === null || changes.constructor.name !== 'Object' || Object.keys(changes).length < 1)
		errors.push(`An object describing changes to be made must be passed, but ${changes} was supplied`);
	if (errors.length) {
		throw errors;
	}

	changes.icon_id = coerceToLong(changes.icon_id); // if it's not there, it'll still be not there

	getGuilds({guild_id: guild_snowflake})
		.then(rows => rows.length > 0)
		.then(recordExists => {
			if (recordExists)
				return db.execute(...schemas.guilds.getUpdateStmt(changes))
					.then(() => getGuilds({guild_id: guild_snowflake}))
					.then(rows => convertTypesForDistribution(rows[0]));
			else
				throw [`Only existing guilds may be updated, but no guild with id ${guild_snowflake} was found`];
		});
};

// returns or throws
const deleteGuild = async (guild_snowflake) => {
	if (guild_snowflake === undefined || guild_snowflake === null)
		throw [`A guild snowflake must be passed, but ${guild_snowflake} was supplied`];
	else guild_snowflake = coerceToLong(guild_snowflake);

	return db.execute(...schemas.guilds.getDeleteStmt({
		guild_id: guild_snowflake
	})).then(() => {});
};

/*************************************************************************
 * channels_by_guild
 */
// returns description of channel, or throws
const createChannel = async (guild_snowflake, name, position = -1) => {
	const errors = [];
	if (guild_snowflake === undefined || guild_snowflake === null)
		errors.push(`A guild snowflake must be passed, but ${guild_snowflake} was supplied`);
	else guild_snowflake = coerceToLong(guild_snowflake);
	if (name === undefined || name === null)
		errors.push(`A name must be passed, but ${name} was supplied`);
	else name = name.toString();
	if (errors.length) {
		throw errors;
	}

	if (!(position > 0)) { // this handles strings and bad guys lmao end me
		// by default, append the channel to the end of the guild
		position = await getChannelsByGuild(guild_snowflake).then(rows => rows.length);
		console.log('using position ' + position);
	} else position = position - 0; // coerce number type

	const record = {
		guild_id: guild_snowflake
		, channel_id: coerceToLong(snowmachine.generate().snowflake)
		, name
		, position
	};

	return db.execute(...schemas.channels_by_guild.getInsertStmt(record))
		.then(() => convertTypesForDistribution(record));
};

// returns list of channel descriptions, or throws
const getChannelsByGuild = async (guild_snowflake, options = {
	before: undefined
	, after: undefined
	, channel_id: undefined
	, limit: undefined
}) => {
	if (options === null) options = {};
	const keys = Object.keys(options);
	const constraints = [];
	let limit = '';
	const params = [];
	const errors = [];

	// mandatory; this is the partition key
	addSnowflakeConstraint('guild_snowflake', 'guild_id =', {guild_snowflake}, constraints, params, errors, true); // true: this is required and will fail if not provided

	// optional constraints
	addSnowflakeConstraint('before'    , 'channel_id <', options, constraints, params, errors);
	addSnowflakeConstraint('after'     , 'channel_id >', options, constraints, params, errors);
	addSnowflakeConstraint('channel_id', 'channel_id =', options, constraints, params, errors);
	limit = generateResultLimit(options.limit, params, errors);

	if (errors.length) {
		throw errors;
	}

	let opt_string = '';
	if (constraints.length) opt_string = 'WHERE ';
	opt_string += constraints.join(' AND ');
	opt_string += limit;

	return db.execute(...schemas.channels_by_guild.getSelectStmt(opt_string, params))
		.then(res => res.rows)
		.then(rows => rows.map(convertTypesForDistribution))
	;
};

// returns or throws
const updateChannel = async (guild_snowflake, channel_snowflake, changes) => {
	const errors = [];
	if (guild_snowflake === undefined || guild_snowflake === null)
		errors.push(`A guild snowflake must be passed, but ${guild_snowflake} was supplied`);
	else guild_snowflake = coerceToLong(guild_snowflake);
	if (channel_snowflake === undefined || channel_snowflake === null)
		errors.push(`A channel snowflake must be passed, but ${channel_snowflake} was supplied`);
	else channel_snowflake = coerceToLong(channel_snowflake);
	if (changes === undefined || changes === null || changes.constructor.name !== 'Object' || Object.keys(changes).length < 1)
		errors.push(`An object describing changes to be made must be passed, but ${changes} was supplied`);
	if (errors.length) {
		throw errors;
	}

	getChannelsByGuild(guild_snowflake, {channel_id: channel_snowflake})
		.then(rows => rows.length > 0)
		.then(recordExists => {
			if (recordExists)
				return db.execute(...schemas.channels_by_guild.getUpdateStmt(changes))
					.then(() => getChannelsByGuild(guild_snowflake, {channel_id: channel_snowflake}))
					.then(rows => convertTypesForDistribution(rows[0]));
			else
				throw [`Only existing channels may be updated, but no channel with id ${channel_snowflake} was found in guild ${guild_snowflake}`];
		});
};

// returns or throws
const deleteChannel = async (guild_snowflake, channel_snowflake) => {
	const errors = [];
	if (guild_snowflake === undefined || guild_snowflake === null)
		errors.push(`A guild snowflake must be passed, but ${guild_snowflake} was supplied`);
	else guild_snowflake = coerceToLong(guild_snowflake);
	if (channel_snowflake === undefined || channel_snowflake === null)
		errors.push(`A channel snowflake must be passed, but ${channel_snowflake} was supplied`);
	else channel_snowflake = coerceToLong(channel_snowflake);
	if (errors.length) {
		throw errors;
	}

	return db.execute(...schemas.channels_by_guild.getDeleteStmt({
		guild_id: guild_snowflake
		, channel_id: channel_snowflake
	})).then(() => {});
};

module.exports = {
	Schema, schemas
	, createGuild, getGuilds, updateGuild, deleteGuild
	, createChannel, getChannelsByGuild, updateChannel, deleteChannel
};
