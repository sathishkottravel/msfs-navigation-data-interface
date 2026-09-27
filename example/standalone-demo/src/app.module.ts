import "reflect-metadata";
import {
  type ArgumentsHost,
  BadGatewayException,
  BadRequestException,
  Catch,
  ConflictException,
  type DynamicModule,
  type INestApplication,
  Module,
  type NestApplicationOptions,
  NotFoundException,
} from "@nestjs/common";
import { APP_FILTER, BaseExceptionFilter, NestFactory, RouterModule } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import {
  AirportsController,
  DatabaseController,
  EnrouteController,
  HealthController,
  RemoteController,
} from "./controllers";
import { ConflictError, NotFoundError, UpstreamError, ValidationError } from "./errors";
import { type NavigationDataSource, NavigationDataService } from "./NavigationDataService";
import { type DataSource, RemoteConfigService } from "./RemoteConfigService";

type ServiceError = ValidationError | NotFoundError | ConflictError | UpstreamError;

/** Maps the services' errors to HTTP errors (400, 404, 409 and 502). Anything else is left to Nest, which responds 500. */
@Catch(ValidationError, NotFoundError, ConflictError, UpstreamError)
class ServiceErrorFilter extends BaseExceptionFilter {
  override catch(error: ServiceError, host: ArgumentsHost) {
    super.catch(toHttpException(error), host);
  }
}

function toHttpException(error: ServiceError) {
  if (error instanceof ValidationError) return new BadRequestException(error.message);
  if (error instanceof NotFoundError) return new NotFoundException(error.message);
  if (error instanceof ConflictError) return new ConflictException(error.message);
  return new BadGatewayException(error.message);
}

export interface AppOptions extends NestApplicationOptions {
  /** Whether the module is the mock or remote data build (default: mock) */
  dataSource?: DataSource;
}

/** The navigation data endpoints, mounted under the data source (`/api/mock` or `/api/remote`) so URLs say where the data comes from */
@Module({})
class NavigationDataModule {}

@Module({})
export class AppModule {
  /**
   * @param source - The navigation data to serve: the JS interface, or a fake in tests
   * @param dataSource - Whether the module is the mock or remote data build
   */
  static register(source: NavigationDataSource, dataSource: DataSource = "mock"): DynamicModule {
    // The services are plain TS, created here rather than decorated, so they stay free of the framework
    const navigationData: DynamicModule = {
      module: NavigationDataModule,
      controllers: [DatabaseController, AirportsController, EnrouteController],
      providers: [{ provide: NavigationDataService, useValue: new NavigationDataService(source) }],
    };

    return {
      module: AppModule,
      imports: [navigationData, RouterModule.register([{ path: dataSource, module: NavigationDataModule }])],
      controllers: [HealthController, RemoteController],
      providers: [
        { provide: RemoteConfigService, useValue: new RemoteConfigService(source, dataSource) },
        { provide: APP_FILTER, useClass: ServiceErrorFilter },
      ],
    };
  }
}

/**
 * Creates the app, with the API under `/api` (the navigation data under `/api/<mock|remote>`), Swagger UI at `/docs` and the OpenAPI spec at `/openapi.json`
 */
export async function createApp(
  source: NavigationDataSource,
  { dataSource, ...options }: AppOptions = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(source, dataSource), options);
  app.setGlobalPrefix("api", { exclude: ["health"] });

  const config = new DocumentBuilder()
    .setTitle(`Navigraph Navigation Data (standalone demo, ${dataSource ?? "mock"} data)`)
    .setDescription(
      "Serves the navigation data of the standalone WASM module, under `/api/mock` with the mock data build and `/api/remote` " +
        "with the remote data build. With the mock data build, only the airports the mock data was generated for (MMUN, MMMD " +
        "and MSLP by default) and their surroundings are available. With the remote data build, download a Navigraph " +
        "navigation data package through `POST /api/remote/download` first.",
    )
    .setVersion("1.0.0")
    .build();
  SwaggerModule.setup("docs", app, () => SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: "openapi.json",
  });

  return app;
}
