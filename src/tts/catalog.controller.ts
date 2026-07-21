import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CatalogService } from './catalog.service';

@Controller('v1/tts/catalog')
@UseGuards(AuthGuard)
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  catalog(): Record<string, unknown> {
    return this.catalogService.catalog();
  }
}
