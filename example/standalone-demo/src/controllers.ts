import { Body, Controller, Get, HttpCode, Param, ParseFloatPipe, Post, Query } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { NavigationDataService } from "./NavigationDataService";
import { RemoteConfigService } from "./RemoteConfigService";

/** Documents the `:ident` path parameter */
const Ident = (example: string, description = "Identifier (case insensitive)") =>
  ApiParam({ name: "ident", example, description });

const AirportIdent = Ident("MMUN", "ICAO identifier of the airport (3-4 letters or digits, case insensitive)");

@ApiTags("Health")
@Controller("health")
export class HealthController {
  @Get()
  health() {
    return { status: "ok" };
  }
}

@ApiTags("Database")
@Controller("database")
export class DatabaseController {
  constructor(private readonly service: NavigationDataService) {}

  @Get()
  @ApiOperation({ summary: "Cycle and install status of the navigation data" })
  getDatabase() {
    return this.service.getDatabase();
  }
}

@ApiTags("Remote")
@Controller("remote")
export class RemoteController {
  constructor(private readonly service: RemoteConfigService) {}

  @Get()
  @ApiOperation({ summary: "Data source of the module (mock or remote), and the state of its navigation data" })
  getConfig() {
    return this.service.getConfig();
  }

  @Post("download")
  @HttpCode(200)
  @ApiOperation({
    summary: "Download a navigation data package into the module (remote data build only)",
    description:
      "Downloads and installs a signed Navigraph navigation data package, replacing the active data. The data is held in " +
      "memory, so it must be downloaded again after a restart. If the download fails, the previous data stays active.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri", description: "Signed URL of a navigation data package" },
      },
    },
  })
  @ApiResponse({ status: 200, description: "The data was installed" })
  @ApiResponse({ status: 400, description: "The URL is missing or malformed" })
  @ApiResponse({ status: 409, description: "The module serves mock data, or a download is already in progress" })
  @ApiResponse({ status: 502, description: "The package could not be downloaded or installed (e.g. an expired URL)" })
  download(@Body("url") url: unknown) {
    return this.service.download(url);
  }

  @Get("cycle")
  @ApiOperation({ summary: "Installed AIRAC cycle compared with the latest one available from Navigraph" })
  checkCycle() {
    return this.service.checkCycle();
  }
}

@ApiTags("Airports")
@Controller("airports")
export class AirportsController {
  constructor(private readonly service: NavigationDataService) {}

  @Get()
  @ApiOperation({ summary: "Airports within a range (NM) of a point" })
  @ApiQuery({ name: "lat", example: 21.04 })
  @ApiQuery({ name: "long", example: -86.87 })
  @ApiQuery({ name: "range", example: 50, description: "Nautical miles, at most 500" })
  getAirportsInRange(
    @Query("lat", ParseFloatPipe) lat: number,
    @Query("long", ParseFloatPipe) long: number,
    @Query("range", ParseFloatPipe) range: number,
  ) {
    return this.service.getAirportsInRange(lat, long, range);
  }

  @Get(":ident")
  @ApiOperation({ summary: "An airport" })
  @AirportIdent
  getAirport(@Param("ident") ident: string) {
    return this.service.getAirport(ident);
  }

  @Get(":ident/runways")
  @ApiOperation({ summary: "Runways of an airport" })
  @AirportIdent
  getRunways(@Param("ident") ident: string) {
    return this.service.getRunways(ident);
  }

  @Get(":ident/departures")
  @ApiOperation({ summary: "Departures (SIDs) of an airport" })
  @AirportIdent
  getDepartures(@Param("ident") ident: string) {
    return this.service.getDepartures(ident);
  }

  @Get(":ident/arrivals")
  @ApiOperation({ summary: "Arrivals (STARs) of an airport" })
  @AirportIdent
  getArrivals(@Param("ident") ident: string) {
    return this.service.getArrivals(ident);
  }

  @Get(":ident/approaches")
  @ApiOperation({ summary: "Approaches of an airport" })
  @AirportIdent
  getApproaches(@Param("ident") ident: string) {
    return this.service.getApproaches(ident);
  }

  @Get(":ident/gates")
  @ApiOperation({ summary: "Gates of an airport" })
  @AirportIdent
  getGates(@Param("ident") ident: string) {
    return this.service.getGates(ident);
  }

  @Get(":ident/communications")
  @ApiOperation({ summary: "Communication frequencies of an airport" })
  @AirportIdent
  getCommunications(@Param("ident") ident: string) {
    return this.service.getCommunications(ident);
  }
}

/** Enroute lookups return every match, as identifiers are not unique */
@ApiTags("Enroute")
@Controller()
export class EnrouteController {
  constructor(private readonly service: NavigationDataService) {}

  @Get("waypoints/:ident")
  @ApiOperation({ summary: "Waypoints with an identifier" })
  @Ident("COSTA")
  getWaypoints(@Param("ident") ident: string) {
    return this.service.getWaypoints(ident);
  }

  @Get("navaids/vhf/:ident")
  @ApiOperation({ summary: "VHF navaids with an identifier" })
  @Ident("CUN")
  getVhfNavaids(@Param("ident") ident: string) {
    return this.service.getVhfNavaids(ident);
  }

  @Get("navaids/ndb/:ident")
  @ApiOperation({ summary: "NDB navaids with an identifier" })
  @Ident("SGA")
  getNdbNavaids(@Param("ident") ident: string) {
    return this.service.getNdbNavaids(ident);
  }

  @Get("airways/:ident")
  @ApiOperation({ summary: "Airways with an identifier" })
  @Ident("A317")
  getAirways(@Param("ident") ident: string) {
    return this.service.getAirways(ident);
  }
}
