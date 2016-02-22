#!/usr/bin/env node

var debug = require("debug")("osm2bvg");
var scrapyard = require("scrapyard");
var queue = require("queue");
var turf = require("turf");
turf.multilinestring = require("turf-multilinestring");

var scraper = new scrapyard({
	retries: 3,
	connections: 5,
	cache: './.cache',
	bestbefore: "10d"
});

// all osm relations containing bvg routes
var input_rels = [53181,18813,174108,58584,18812,174283,18812,174255,175260]

function osm2bvg(fn){
	fetch(function(err, data){
		if (err) return fn(err);
		makeGeoJSON(data, fn);
	});
};

// make a geojson
// sadly, it's impossible to make every route into a featureCollection
// because geojson does not support that. so i ignore all stops and platforms
// and just export every route as a multiLineString.
function makeGeojson(data, fn){
	fn(null, turf.featurecollection(data.map(function(route){
		
		route.tags.id = route.id;
		route.tags.parent = route.parent;

		// if colour, assign stroke colour
		if (route.tags.hasOwnProperty("colour")) {
			route.tags.stroke = route.tags.colour;
		}
		
		// assign stroke widths
		switch (route.tags.route) {
			case "subway": 
			case "light_rail": 
				route.tags["stroke-width"] = 2; 
			break;
			default: 
				route.tags["stroke-width"] = 1; 
			break;
		}

		// remove platforms and make multilinestring of track
		return turf.multilinestring(route.track.filter(function(seg){
			return (seg.role !== "platform") {
		}).map(function(segment){
			return segment.linestring
		}), route.tags);
		
	})));
		
};
 
// fetch everything
function fetch(fn){
	fetchRoutes(input_rels, function(err,routes){
		if (err) return debug("error fetching routes")

		var q = queue({
			concurrency: 10,
			timeout: 10000
		});

		var result = [];

		routes.forEach(function(route){
			q.push(function(next){
				fetchRoute(route, function(err, data){
					if (err) debug("error fetching route %d: %s", route.id, err) || next();
					result.push(data);
					next();
				});
			});
		});

		q.start(function(err){
			if (err) return debug("queue execution failed: %s", err) || fn(err);
			fn(null, result);
		});

	});
};

// retrieve a single node
function fetchNode(id, fn){
	scraper({url: "http://www.openstreetmap.org/api/0.6/node/"+id, type: "xml", encoding: "utf8" }, function(err, xml){
		debug("got node %d", id);
		if (err) return debug("error fetching node %d: %s", id, err) || next();
		parseOSM(xml, function(err, osm){
			if (err) return fn(err);
			fn(null, osm);
		});
	});
};

// retrieve a way and resolve all nodes
function fetchWay(id, fn){
	scraper({url: "http://www.openstreetmap.org/api/0.6/way/"+id, type: "xml", encoding: "utf8" }, function(err, xml){
		if (err) return debug("error fetching way %d: %s", id, err) || next();
		debug("got way %d", id);
		parseOSM(xml, function(err, osm){
			osm.linestring = new Array(osm.nodes.length);

			var q = queue({
				concurrency: 3,
				timeout: 10000
			});
			
			osm.nodes.forEach(function(nodeid, noden){
				q.push(function(next){
					fetchNode(nodeid, function(err, node){
						if (err) return debug("clould not fetch node %d for way %d: %s", nodeid, id, err) || next();
						osm.linestring[noden] = node.coords;
						next();
					});
				});
			});
			
			// execute queue
			q.start(function(err){
				if (err) return debug("could not fetch way %d: %s", id, err) || fn(err);
				fn(null, osm);
			});
			
		});
	});
};

// fetch a particular route
function fetchRoute(route, fn){

	// fetch all ways
	var q = queue({
		concurrency: 1,
		timeout: 10000
	});
	
	// again, the data is pretty rough, sometimes the ways tagged with "forward" are relevant,
	// sometimes, all ways without a role, and sometimes a hodge podge of both. 
	// also, sometimes there are stops wit hor without platforms, sometimes there are just platforms
	// alle these could be meaningful, so we collect all and figure it out later
	//
	// roles of nodes: "", "backward", "forward", "forward_stop", "platform", "platform: endhaltestelle", "platform: to kaserne hottengrund", "platform:endhaltestelle", "platform:service", "platform_exit_only", "stop", "stop:service", "stop_entry_only", "stop_exit_only"
	// roles of ways: "", "backward", "forward", "forward:turning loop", "platform", "route"

	// fetch ways
	var ways = new Array(route.ways.length);
	route.ways.forEach(function(way, wayn){
		q.push(function(next){
			fetchWay(way.id, function(err, data){
				if (err) return debug("clould not fetch way %d for route %d: %s", way.id, route.id, err) || next();
				data.role = way.role;
				ways[wayn] = data;
				next();
			});
		});
	});

	// fetch nodes
	var nodes = new Array(route.nodes.length);
	route.nodes.forEach(function(node, noden){
		q.push(function(next){
			fetchNode(node.id, function(err, data){
				if (err) return debug("clould not fetch node %d for route %d: %s", node.id, route.id, err) || next();
				data.role = node.role;
				nodes[noden] = data;
				next();
			});
		});
	});
	
	// execute queue
	q.start(function(err){
		if (err) return debug("could not fetch route %d: %s", route.id, err) || fn(err);
		route.track = ways;
		route.stops = nodes;
		fn(null, route);
	});

};

// fetch all routes
function fetchRoutes(rels, fn){
	var result = [];

	var q = queue({
		concurrency: 10,
		timeout: 10000
	});
	
	var fetchedRels = [];
	
	function resolveRelation(rel, parent, next){
		
		// prevent double fetching
		if (fetchedRels.indexOf(rel) >= 0) return debug("alreaded fetched relation %d", rel) || next();
		fetchedRels.push(rel);
		
		// fetch
		scraper({url: "http://www.openstreetmap.org/api/0.6/relation/"+rel, type: "xml", encoding: "utf8" }, function(err, xml){
			if (err) return debug("error fetching relation %d: %s", rel, err) || next();
			parseOSM(xml, function(err, osm){
				if (err) return debug("error parsing osm data for relation %d: %s", rel, err) || next();
				if (osm["type"] !== "relation") return debug("osm entity %d is not a relation", rel) || next();
				if (!osm.tags.hasOwnProperty("type")) return debug("osm relation %d has no type", rel) || next();
				switch (osm.tags["type"]) {
					case "route":
					case "network":
					case "route_master":

						// there isn't a consistent, reliable way to tell when we hit rock bottom
						// osm users seem to use route and route_master by random
						// and add irrelevant nodes to relations at their pleasure
						// for now: it's rock bottom if we find ways ¯\_(ツ)_/¯

						if (osm.ways.length > 0) {
							debug("found single line %d: %s (%s)", rel, osm.tags["name"], osm.tags["ref"]);
							osm["parent"] = parent;
							result.push(osm);
							break;
						}
						
						if (osm.relations.length > 0) {
							debug("relation %d has %d subrelations", rel, osm.relations.length);
							osm.relations.forEach(function(r){
								q.push(function(next){
									resolveRelation(r.id, rel, next);
								});
							});
							break;
						}
						
						debug("ran into trouble with relation %d: %j", rel, osm);

					break;
					default:
						debug("osm relation %d has ignored type %s", rel, osm.tags["type"]);
					break;
				}
				// declare this thing done
				next();
			});
		});
	};
	
	rels.forEach(function(relid){
		debug("pushing relation %d to queue", relid);
		q.push(function(next){
			resolveRelation(relid, 0, next);
		});
	});
	
	// execute queue
	q.start(function(err){
		if (err) return debug("queue execution failed: %s", err) || fn(err);
		fn(null, result);
	});
	
};

// sort references by their role
function structureRefs(osm, fn){

	var nodes = {};
	osm.nodes.forEach(function(node){
		if (!node.hasOwnProperty("role") || node.role === "") node.role = "_";
		if (!nodes.hasOwnProperty(node.role)) nodes[node.role] = [];
		nodes[node.role].push(node.id);
	});

	var ways = {};
	osm.ways.forEach(function(way){
		if (!way.hasOwnProperty("role") || way.role === "") way.role = "_";
		if (!ways.hasOwnProperty(way.role)) ways[way.role] = [];
		ways[way.role].push(way.id);
	});

	var relations = {};
	osm.relations.forEach(function(relation){
		if (!relation.hasOwnProperty("role") || relation.role === "") relation.role = "_";
		if (!relations.hasOwnProperty(relation.role)) relations[relation.role] = [];
		relations[relation.role].push(relation.id);
	});

	osm.relations = relations;
	osm.nodes = nodes;
	osm.ways = ways;
	
	fn(null, osm);
	
};

// little helper to bring osm entities to a common format
function parseOSM(xml, fn){
		
	var result = {
		type: null,
		id: null,
		tags: {}
	};
	
	if (xml.osm.hasOwnProperty("node")){

		var xml = xml.osm.node[0];
		result.type = "node";
		result.coords = [parseFloat(xml["$"].lon), parseFloat(xml["$"].lat)];

	} else if (xml.osm.hasOwnProperty("way")){
		var xml = xml.osm.way[0];
		result.type = "way";
		
		// add nodes
		result.nodes = [];
		if (xml.hasOwnProperty("nd")) xml.nd.forEach(function(n){
			result["nodes"].push(parseInt(n["$"].ref,10));
		});

	} else if (xml.osm.hasOwnProperty("relation")){
		var xml = xml.osm.relation[0];
		result.type = "relation";
		
		// add members
		result.relations = [];
		result.nodes = [];
		result.ways = [];
		if (xml.hasOwnProperty("member")) xml.member.forEach(function(m){
			result[m["$"].type+"s"].push({
				id: parseInt(m["$"].ref,10),
				role: m["$"].role
			});
		});

	} else {
		// this is broken
		return debug("invalid osm data") || fn(new Error("invalid osm data"));
	}
	
	// add result id
	result.id = parseInt(xml["$"].id,10);
	
	// add tags
	if (xml.hasOwnProperty("tag")) xml.tag.forEach(function(tag){
		result.tags[tag["$"].k] = tag["$"].v;
	});
	
	return fn(null, result);
	
};

if (require.main === module) {
	osm2bvg(function(err, data){
		if (err) return console.error(err) || process.exit(1);
		console.log(JSON.stringify(data,null,"\t"));
	});
} else {
	module.exports = osm2bvg;
}