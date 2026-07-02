/* venues-data.js
   Static venue data with coordinates. In production, generate this file
   as part of your fetch pipeline: merge venues.json (name, address, type)
   with events.json (grouped by venueId) and geocoded lat/lng, then write
   it out alongside your other build artifacts.

   Exposed as a global so venue-map.js can read it without a bundler.
   If you later move to ES modules, swap this for `export const VENUES = ...`
*/
window.VENUES = [
  {
    id: "beachland",
    name: "Beachland Ballroom",
    type: "music-hall",
    address: "15711 Waterloo Rd, Cleveland, OH",
    lat: 41.5631, lng: -81.5577,
    events: [
      { title: "Snail Mail w/ support", date: "Jul 3", eventUrl: "#" },
      { title: "Local Noise Fest Night 2", date: "Jul 9", eventUrl: "#" }
    ]
  },
  {
    id: "grogshop",
    name: "Grog Shop",
    type: "club",
    address: "2785 Euclid Heights Blvd, Cleveland Heights, OH",
    lat: 41.5054, lng: -81.5763,
    events: [
      { title: "Indie Showcase: The Hollow Coves", date: "Jul 5", eventUrl: "#" }
    ]
  },
  {
    id: "agora",
    name: "Agora Theatre",
    type: "theater",
    address: "5000 Euclid Ave, Cleveland, OH",
    lat: 41.5048, lng: -81.6536,
    events: []
  },
  {
    id: "rocketarena",
    name: "Rocket Arena",
    type: "arena",
    address: "1 Center Ct, Cleveland, OH",
    lat: 41.4965, lng: -81.6881,
    events: [
      { title: "Cavs Preseason Watch Night", date: "Jul 14", eventUrl: "#" }
    ]
  },
  {
    id: "happydog",
    name: "Happy Dog",
    type: "bar",
    address: "5801 Detroit Ave, Cleveland, OH",
    lat: 41.4825, lng: -81.7188,
    events: [
      { title: "DIY Punk Night", date: "Jul 2", eventUrl: "#" }
    ]
  },
  {
    id: "musicbox",
    name: "Music Box Supper Club",
    type: "music-hall",
    address: "1148 Main Ave, Cleveland, OH",
    lat: 41.4966, lng: -81.7028,
    events: []
  }
];
