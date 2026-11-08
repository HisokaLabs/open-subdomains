var REG_NONE = NewRegistrar('none');
var DNS_PROVIDER = DnsProvider(NewDnsProvider('cloudflare'));

var PROXY = {
	on: { cloudflare_proxy: 'on' },
	off: { cloudflare_proxy: 'off' },
};

var GITHUB_PAGES_A = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];
var GITHUB_PAGES_AAAA = ['2606:50c1:8000::153', '2606:50c1:8001::153', '2606:50c1:8002::153', '2606:50c1:8003::153'];

/**
 * The zone list comes from registry/zones.json, the file the validator reads,
 * so a zone cannot be declared here and refused there.
 */
function loadZones() {
	var list = require('./registry/zones.json');
	if (!list || !list.length) {
		throw new Error('dnsconfig: registry/zones.json lists no zones, refusing to push');
	}
	return list.map(function (zone) {
		return String(zone).toLowerCase();
	});
}

/**
 * Every JSON file in domains/ is a claim, and its filename is the record name:
 * jane.is-a.ceo.json answers for jane.is-a.ceo. Nothing in the file repeats it,
 * so renaming the file is the only way to move a claim.
 */
function readClaims(zones) {
	var claims = [];
	var files = glob.apply(null, ['./domains', false, '.json']);

	files.forEach(function (file) {
		var base = file.split('/').pop().split('\\').pop();

		for (var i = 0; i < zones.length; i += 1) {
			var suffix = '.' + zones[i] + '.json';
			if (base.slice(-suffix.length) !== suffix) continue;

			var subdomain = base.slice(0, -suffix.length);
			if (!subdomain) return;

			try {
				var normalized = file.indexOf('.') === 0 || file.indexOf('/') === 0 || file.indexOf('\\') === 0 || file.indexOf(':') === 1
					? file
					: './' + file;
				claims.push({ file: file, subdomain: subdomain, zone: zones[i], data: require(normalized) });
			} catch (error) {
				console.error('dnsconfig: error loading ' + file + ': ' + error);
			}
			return;
		}

		console.error('dnsconfig: skipping ' + file + ', its filename names no managed zone');
	});

	return claims;
}

var ZONES = loadZones();
var claims = readClaims(ZONES);

var recordsByZone = {};

function addRecord(zone, record) {
	if (!recordsByZone[zone]) {
		recordsByZone[zone] = [];
	}
	recordsByZone[zone].push(record);
}

function fqdn(target) {
	return target.slice(-1) === '.' ? target : target + '.';
}

claims.forEach(function (claim) {
	var data = claim.data || {};
	var zone = claim.zone;
	var name = claim.subdomain;
	var proxy = data.proxied === true ? PROXY.on : PROXY.off;
	var records = data.records;

	if (!records) {
		// No records key means GitHub Pages. The proxy stays off because proxying
		// breaks Pages certificate issuance.
		GITHUB_PAGES_A.forEach(function (ip) {
			addRecord(zone, A(name, ip, PROXY.off));
		});
		GITHUB_PAGES_AAAA.forEach(function (ip6) {
			addRecord(zone, AAAA(name, ip6, PROXY.off));
		});
		return;
	}

	if (records.A && records.A.length !== 0) { 
		records.A.forEach(function (ip) {
			addRecord(zone, A(name, ip, proxy));
		});
	}

	if (records.AAAA && records.AAAA.length !== 0) {
		records.AAAA.forEach(function (ip6) {
			addRecord(zone, AAAA(name, ip6, proxy));
		});
	}

	if (records.CNAME) {
		var targets = typeof records.CNAME === 'string' ? [records.CNAME] : records.CNAME;
		targets.forEach(function (target) {
			addRecord(zone, CNAME(name, fqdn(target), proxy));
		});
	}

	if (records.TXT && records.TXT.length !== 0) {
		records.TXT.forEach(function (txt) {
			addRecord(zone, TXT(name, txt));
		});
	}

	if (records.MX && records.MX.length !== 0) {
		records.MX.forEach(function (mx) {
			addRecord(zone, MX(name, mx.priority, fqdn(mx.target)));
		});
	}

	if (records.NS && records.NS.length !== 0) {
		records.NS.forEach(function (ns) {
			addRecord(zone, NS(name, fqdn(ns)));
		});
	}

	if (records.SRV && records.SRV.length !== 0) {
		records.SRV.forEach(function (srv) {
			addRecord(zone, SRV(name, srv.priority, srv.weight, srv.port, fqdn(srv.target)));
		});
	}

	if (records.CAA && records.CAA.length !== 0) {
		records.CAA.forEach(function (caa) {
			addRecord(zone, CAA(name, caa.flag, caa.tag, caa.value));
		});
	}

	if (records.PTR && records.PTR.length !== 0) {
		records.PTR.forEach(function (ptr) {
			addRecord(zone, PTR(name, fqdn(ptr)));
		});
	}
});

/**
 * A reserved name is managed by hand in the Cloudflare dashboard, so this
 * script must never touch it. Without the IGNORE, purge mode would delete any
 * record the repository does not declare, which is every reserved name that has
 * no entry file.
 */
function reservedGuard(zone, records) {
	var reserved = require('./registry/reserved.json');
	var claimed = {};

	claims.forEach(function (claim) {
		if (claim.zone === zone) claimed[claim.subdomain] = true;
	});

	reserved.forEach(function (label) {
		if (!claimed[label]) records.push(IGNORE(label));
	});

	return records;
}

Object.keys(recordsByZone).forEach(function (zone) {
	D(zone, REG_NONE, DNS_PROVIDER, reservedGuard(zone, recordsByZone[zone]));
});

