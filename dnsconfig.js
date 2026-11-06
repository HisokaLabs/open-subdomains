var REG_NONE = NewRegistrar('none');
var DNS_PROVIDER = DnsProvider(NewDnsProvider('cloudflare'));

/** Cloudflare proxy state, chosen per entry with the "proxied" flag. */
var PROXY = {
	on: { cloudflare_proxy: 'on' },
	off: { cloudflare_proxy: 'off' },
};

/**
 * GitHub Pages, the default landing target for any entry whose JSON file
 * specifies no records of its own.
 */
var GITHUB_PAGES_A = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];

var GITHUB_PAGES_AAAA = ['2606:50c1:8000::153', '2606:50c1:8001::153', '2606:50c1:8002::153', '2606:50c1:8003::153'];

function getDomainsList(filesPath) {
	var result = [];
	var files = glob.apply(null, [filesPath, false, '.json']);

	files.forEach(function (file) {
		var basename = file.split('/').pop().split('\\').pop();
		if (basename === '_meta.json' || basename === '_example.json' || basename === 'SCHEMA.json') {
			return;
		}
		try {
			var normalizedFile = file.indexOf('.') === 0 || file.indexOf('/') === 0 || file.indexOf('\\') === 0 || file.indexOf(':') === 1 ? file : './' + file;
			var data = require(normalizedFile);
			if (!data.domain || !data.subdomain) {
				console.error('dnsconfig: skipping ' + file + ', missing "domain" or "subdomain"');
				return;
			}
			result.push({ file: file, data: data });
		} catch (error) {
			console.error('dnsconfig: error loading ' + file + ':', error);
		}
	});

	return result;
}

/** Group records by zone so each zone can be declared exactly once. */
var recordsByZone = {};

function addRecord(zone, record) {
	if (!recordsByZone[zone]) {
		recordsByZone[zone] = [];
	}
	recordsByZone[zone].push(record);
}


function managedZones() {
	var meta = require('./domains/_meta.json');
	var body = meta._meta || meta;
	var list = body.zones;
	if (!list || !list.length) {
		throw new Error('dnsconfig: domains/_meta.json lists no zones, refusing to push');
	}
	return list.map(function (zone) {
		return String(zone).toLowerCase();
	});
}

var ZONES = managedZones();

var domains = getDomainsList('./domains');

var refused = [];

domains.forEach(function (entry) {
	var data = entry.data;
	var zone = String(data.domain).toLowerCase();
	var name = data.subdomain;

	if (ZONES.indexOf(zone) === -1) {
		refused.push(entry.file + ' claims zone "' + zone + '", which is not in _meta.json zones');
		return;
	}

	var proxyState = data.proxied === true ? PROXY.on : PROXY.off;
	var records = data.records;

	if (!records) {
		// Nothing specified at all: GitHub Pages default. Never proxied, because
		// proxying breaks Pages certificate issuance.
		GITHUB_PAGES_A.forEach(function (ip) {
			addRecord(zone, A(name, ip, PROXY.off));
		});
		GITHUB_PAGES_AAAA.forEach(function (ip6) {
			addRecord(zone, AAAA(name, ip6, PROXY.off));
		});
		return;
	}

	(records.A || []).forEach(function (ip) {
		addRecord(zone, A(name, ip, proxyState));
	});
	(records.AAAA || []).forEach(function (ip6) {
		addRecord(zone, AAAA(name, ip6, proxyState));
	});
	var cnames = typeof records.CNAME === 'string' ? [records.CNAME] : (records.CNAME || []);
	cnames.forEach(function (target) {
		var fqdn = target.slice(-1) === '.' ? target : target + '.';
		addRecord(zone, CNAME(name, fqdn, proxyState));
	});
	(records.TXT || []).forEach(function (txt) {
		addRecord(zone, TXT(name, txt));
	});
	(records.MX || []).forEach(function (mx) {
		var fqdn = mx.target.slice(-1) === '.' ? mx.target : mx.target + '.';
		addRecord(zone, MX(name, mx.priority, fqdn));
	});
	(records.NS || []).forEach(function (ns) {
		var fqdn = ns.slice(-1) === '.' ? ns : ns + '.';
		addRecord(zone, NS(name, fqdn));
	});
	(records.SRV || []).forEach(function (srv) {
		var fqdn = srv.target.slice(-1) === '.' ? srv.target : srv.target + '.';
		addRecord(zone, SRV(name, srv.priority, srv.weight, srv.port, fqdn));
	});
	(records.CAA || []).forEach(function (caa) {
		addRecord(zone, CAA(name, caa.flag, caa.tag, caa.value));
	});
	(records.PTR || []).forEach(function (ptr) {
		var fqdn = ptr.slice(-1) === '.' ? ptr : ptr + '.';
		addRecord(zone, PTR(name, fqdn));
	});
});

if (refused.length > 0) {
	throw new Error('dnsconfig: refusing to push, the registry names unmanaged zones:\n  ' + refused.join('\n  '));
}

Object.keys(recordsByZone).forEach(function (zone) {
	D(zone, REG_NONE, DNS_PROVIDER, recordsByZone[zone]);
});
