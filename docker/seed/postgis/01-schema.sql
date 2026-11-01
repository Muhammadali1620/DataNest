-- Test data for PostgreSQL with PostGIS (V13.13). Runs once on container start (as the
-- datanest superuser). Integration tests rely on these exact rows: change them together
-- with test/integration/postgis.
\set ON_ERROR_STOP on
SET client_encoding = 'UTF8';
SET TIME ZONE 'UTC';

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE spatial_places (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  location geometry(Point, 4326),
  area geometry,
  trail geography(LineString, 4326),
  note TEXT
);

INSERT INTO spatial_places (id, name, location, area, trail, note) VALUES
  (1, 'Office',
   ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326),
   ST_GeomFromText('POLYGON((0 0, 4 0, 4 4, 0 4, 0 0))'),
   'SRID=4326;LINESTRING(13.4 52.5, 13.5 52.6)'::geography,
   'SRID=4326;POINT(1 2)'),
  (2, 'Depot',
   ST_SetSRID(ST_MakePoint(-0.1278, 51.5074), 4326),
   ST_GeomFromEWKT('SRID=3857;MULTIPOINT((1 2), (3 4))'),
   NULL,
   NULL),
  (3, 'Roof',
   ST_SetSRID(ST_MakePoint(13.41, 52.51), 4326),
   ST_GeomFromEWKT('SRID=4979;POINT Z (1 2 3)'),
   NULL,
   'POINT(1 2)'),
  (4, 'Nowhere', NULL, ST_GeomFromText('POINT EMPTY'), NULL, NULL),
  (5, 'Mixed',
   NULL,
   ST_GeomFromText('GEOMETRYCOLLECTION(POINT(1 2), LINESTRING(0 0, 1 1))'),
   NULL,
   NULL);
