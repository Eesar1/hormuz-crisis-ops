"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MapLibreMap, Marker } from "maplibre-gl";
import type { Position, RestrictedZone, ShipState, WeatherCell } from "@/lib/types";

maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

interface FleetMapProps {
  ships: ShipState[];
  zones: RestrictedZone[];
  weather: WeatherCell[];
  navigableWater: Position[];
  selectedShipId?: string;
  onSelectShip?: (shipId: string) => void;
  commandMode?: boolean;
  onCreateZone?: (name: string, points: Position[]) => Promise<void> | void;
  onUpdateZone?: (id: string, points: Position[]) => Promise<void> | void;
  onDeleteZone?: (id: string) => Promise<void> | void;
}

type LngLat = [number, number];
const toLngLat = (p: Position): LngLat => [p[1], p[0]];
const toPosition = (p: LngLat): Position => [p[1], p[0]];

function emptyCollection(): any {
  return { type: "FeatureCollection", features: [] };
}

export function FleetMap({
  ships,
  zones,
  weather,
  navigableWater,
  selectedShipId,
  onSelectShip,
  commandMode = false,
  onCreateZone,
  onUpdateZone,
  onDeleteZone,
}: FleetMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const shipMarkersRef = useRef(new Map<string, Marker>());
  const editMarkersRef = useRef<Marker[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [draft, setDraft] = useState<LngLat[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState<string>();
  const [editMode, setEditMode] = useState(false);
  const [editPoints, setEditPoints] = useState<LngLat[]>([]);
  const latestDrawMode = useRef(drawMode);
  const latestEditMode = useRef(editMode);

  useEffect(() => { latestDrawMode.current = drawMode; }, [drawMode]);
  useEffect(() => { latestEditMode.current = editMode; }, [editMode]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [54.8, 25.8],
      zoom: 5.25,
      minZoom: 4,
      maxZoom: 12,
      attributionControl: false,
      style: {
        version: 8,
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [
          { id: "background", type: "background", paint: { "background-color": "#07131b" } },
          { id: "osm", type: "raster", source: "osm", paint: { "raster-opacity": 0.42, "raster-saturation": -0.7, "raster-contrast": 0.25, "raster-brightness-max": 0.55 } },
        ],
      },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    map.on("load", () => {
      map.addSource("water-area", { type: "geojson", data: emptyCollection() });
      map.addLayer({ id: "water-area-fill", type: "fill", source: "water-area", paint: { "fill-color": "#0d6f91", "fill-opacity": 0.12 } });
      map.addLayer({ id: "water-area-line", type: "line", source: "water-area", paint: { "line-color": "#48c6ef", "line-opacity": 0.32, "line-width": 1 } });

      map.addSource("routes", { type: "geojson", data: emptyCollection() });
      map.addLayer({ id: "routes-line", type: "line", source: "routes", paint: { "line-color": ["get", "color"], "line-width": ["case", ["get", "selected"], 4, 2], "line-opacity": ["case", ["get", "selected"], 0.95, 0.34], "line-dasharray": [1.5, 1] } });

      map.addSource("zones", { type: "geojson", data: emptyCollection() });
      map.addLayer({ id: "zones-fill", type: "fill", source: "zones", paint: { "fill-color": "#ff4d5e", "fill-opacity": ["case", ["get", "selected"], 0.28, 0.16] } });
      map.addLayer({ id: "zones-line", type: "line", source: "zones", paint: { "line-color": "#ff6978", "line-width": ["case", ["get", "selected"], 3, 2], "line-dasharray": [2, 1] } });

      map.addSource("weather", { type: "geojson", data: emptyCollection() });
      map.addLayer({
        id: "weather-cells",
        type: "circle",
        source: "weather",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 12, 8, 32],
          "circle-color": ["match", ["get", "condition"], "severe", "#ff355e", "adverse", "#ff9b3f", "moderate", "#ffd166", "#3dd6a1"],
          "circle-opacity": ["match", ["get", "condition"], "severe", 0.26, "adverse", 0.2, "moderate", 0.1, 0.025],
          "circle-blur": 0.45,
        },
      });

      map.addSource("draft-zone", { type: "geojson", data: emptyCollection() });
      map.addLayer({ id: "draft-fill", type: "fill", source: "draft-zone", paint: { "fill-color": "#7ce7ff", "fill-opacity": 0.12 } });
      map.addLayer({ id: "draft-line", type: "line", source: "draft-zone", paint: { "line-color": "#7ce7ff", "line-width": 2, "line-dasharray": [1, 1] } });

      setLoaded(true);
    });

    map.on("click", (event) => {
      if (latestDrawMode.current) {
        setDraft((old) => [...old, [event.lngLat.lng, event.lngLat.lat]]);
        return;
      }
      if (latestEditMode.current) return;
      const features = map.queryRenderedFeatures(event.point, { layers: ["zones-fill"] });
      const id = features[0]?.properties?.id;
      if (typeof id === "string") setSelectedZoneId(id);
    });

    return () => {
      shipMarkersRef.current.forEach((marker) => marker.remove());
      editMarkersRef.current.forEach((marker) => marker.remove());
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!loaded || !mapRef.current) return;
    const map = mapRef.current;
    const ring = navigableWater.map(toLngLat);
    const closed = ring.length ? [...ring, ring[0]] : ring;
    (map.getSource("water-area") as GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: closed.length ? [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [closed] } }] : [],
    });
  }, [loaded, navigableWater]);

  useEffect(() => {
    if (!loaded || !mapRef.current) return;
    const map = mapRef.current;
    const features: any[] = ships
      .filter((ship) => ship.route?.length > 1)
      .map((ship) => ({
        type: "Feature",
        properties: {
          shipId: ship.shipId,
          selected: ship.shipId === selectedShipId,
          color: ship.shipId === selectedShipId ? "#80f4ff" : "#5db6d5",
        },
        geometry: { type: "LineString", coordinates: [toLngLat(ship.position), ...ship.route.slice(ship.routeIndex).map(toLngLat)] },
      }));
    (map.getSource("routes") as GeoJSONSource)?.setData({ type: "FeatureCollection", features });
  }, [loaded, ships, selectedShipId]);

  useEffect(() => {
    if (!loaded || !mapRef.current) return;
    const map = mapRef.current;
    const liveIds = new Set(ships.map((s) => s.shipId));
    for (const [id, marker] of shipMarkersRef.current) {
      if (!liveIds.has(id)) {
        marker.remove();
        shipMarkersRef.current.delete(id);
      }
    }
    for (const ship of ships) {
      let marker = shipMarkersRef.current.get(ship.shipId);
      if (!marker) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "ship-marker";
        el.dataset.shipId = ship.shipId;
        el.innerHTML = `<span class="ship-arrow">▲</span><span class="ship-label"></span>`;
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          onSelectShip?.(ship.shipId);
        });
        const createdMarker = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat(toLngLat(ship.position))
          .addTo(map) as Marker;
        shipMarkersRef.current.set(ship.shipId, createdMarker);
        marker = createdMarker;
      }
      if (!marker) continue;
      marker.setLngLat(toLngLat(ship.position));
      const el = marker.getElement();
      el.classList.toggle("selected", ship.shipId === selectedShipId);
      el.classList.toggle("danger", ["distressed", "zone_breach", "out_of_fuel", "stranded"].includes(ship.status));
      const arrow = el.querySelector<HTMLElement>(".ship-arrow");
      if (arrow) arrow.style.transform = `rotate(${ship.heading}deg)`;
      const label = el.querySelector<HTMLElement>(".ship-label");
      if (label) label.textContent = ship.shipId;
    }
  }, [loaded, ships, selectedShipId, onSelectShip]);

  useEffect(() => {
    if (!loaded || !mapRef.current) return;
    const features: any[] = zones.map((zone) => {
      const ring = zone.points.map(toLngLat);
      return {
        type: "Feature",
        properties: { id: zone.id, name: zone.name, selected: zone.id === selectedZoneId },
        geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
      };
    });
    (mapRef.current.getSource("zones") as GeoJSONSource)?.setData({ type: "FeatureCollection", features });
  }, [loaded, zones, selectedZoneId]);

  useEffect(() => {
    if (!loaded || !mapRef.current) return;
    const features: any[] = weather.map((cell) => ({
      type: "Feature",
      properties: { condition: cell.condition, wind: cell.windKnots },
      geometry: { type: "Point", coordinates: toLngLat(cell.position) },
    }));
    (mapRef.current.getSource("weather") as GeoJSONSource)?.setData({ type: "FeatureCollection", features });
  }, [loaded, weather]);

  useEffect(() => {
    if (!loaded || !mapRef.current) return;
    const source = mapRef.current.getSource("draft-zone") as GeoJSONSource;
    const points = editMode ? editPoints : draft;
    const feature: any | null = points.length >= 2 ? {
      type: "Feature",
      properties: {},
      geometry: points.length >= 3
        ? { type: "Polygon", coordinates: [[...points, points[0]]] }
        : { type: "LineString", coordinates: points },
    } : null;
    source?.setData({ type: "FeatureCollection", features: feature ? [feature] : [] });
  }, [loaded, draft, editPoints, editMode]);

  useEffect(() => {
    editMarkersRef.current.forEach((marker) => marker.remove());
    editMarkersRef.current = [];
    if (!loaded || !mapRef.current || !editMode) return;
    editPoints.forEach((point, index) => {
      const el = document.createElement("div");
      el.className = "zone-vertex";
      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat(point)
        .addTo(mapRef.current!);
      marker.on("drag", () => {
        const ll = marker.getLngLat();
        setEditPoints((old) => old.map((p, i) => i === index ? [ll.lng, ll.lat] : p));
      });
      editMarkersRef.current.push(marker);
    });
    return () => {
      editMarkersRef.current.forEach((marker) => marker.remove());
      editMarkersRef.current = [];
    };
  }, [loaded, editMode]);

  const selectedZone = useMemo(() => zones.find((z) => z.id === selectedZoneId), [zones, selectedZoneId]);

  const finishDraw = async () => {
    if (draft.length < 3 || !onCreateZone) return;
    const name = `Restricted Zone ${zones.length + 1}`;
    await onCreateZone(name, draft.map(toPosition));
    setDraft([]);
    setDrawMode(false);
  };

  const beginEdit = () => {
    if (!selectedZone) return;
    setEditPoints(selectedZone.points.map(toLngLat));
    setEditMode(true);
    setDrawMode(false);
  };

  const saveEdit = async () => {
    if (!selectedZone || editPoints.length < 3 || !onUpdateZone) return;
    await onUpdateZone(selectedZone.id, editPoints.map(toPosition));
    setEditMode(false);
    setEditPoints([]);
  };

  return (
    <div className="map-shell">
      <div ref={containerRef} className="map-canvas" />
      <div className="map-legend">
        <span><i className="legend-dot normal" /> normal</span>
        <span><i className="legend-dot adverse" /> adverse weather</span>
        <span><i className="legend-zone" /> restricted</span>
      </div>
      {commandMode ? (
        <div className="map-tools">
          {!drawMode && !editMode ? (
            <>
              <button className="tool-btn" onClick={() => { setDrawMode(true); setDraft([]); setSelectedZoneId(undefined); }}>＋ Draw zone</button>
              {selectedZone ? <button className="tool-btn" onClick={beginEdit}>✦ Edit selected</button> : null}
              {selectedZone ? <button className="tool-btn danger" onClick={() => onDeleteZone?.(selectedZone.id)}>Delete</button> : null}
            </>
          ) : null}
          {drawMode ? (
            <>
              <span className="tool-hint">Click ≥3 points to outline a restricted zone</span>
              <button className="tool-btn primary" disabled={draft.length < 3} onClick={finishDraw}>Finish zone ({draft.length})</button>
              <button className="tool-btn" onClick={() => { setDraft([]); setDrawMode(false); }}>Cancel</button>
            </>
          ) : null}
          {editMode ? (
            <>
              <span className="tool-hint">Drag vertices, then save</span>
              <button className="tool-btn primary" onClick={saveEdit}>Save zone</button>
              <button className="tool-btn" onClick={() => { setEditMode(false); setEditPoints([]); }}>Cancel</button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
