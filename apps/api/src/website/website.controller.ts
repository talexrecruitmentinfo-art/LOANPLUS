import {
  Body, Controller, Delete, Get, Header, Param, Post, Put, Req, Res, UseGuards,
} from '@nestjs/common';
import { IsInt, IsObject, IsString, Max, Min } from 'class-validator';
import type { Response } from 'express';
import { AuthenticatedRequest } from '../auth/request.types';
import { SuperadminSessionGuard } from '../auth/session.guard';
import { WebsiteService } from './website.service';

class SaveWebsiteDraftDto {
  @IsObject()
  content!: Record<string, unknown>;

  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  expectedVersion!: number;
}

class PublishWebsiteDto {
  @IsInt()
  @Min(1)
  @Max(2_000_000_000)
  expectedVersion!: number;
}

class UploadWebsiteAssetDto {
  @IsString()
  data!: string;

  @IsString()
  mimeType!: string;
}

@Controller('platform/website')
export class PublicWebsiteController {
  constructor(private readonly website: WebsiteService) {}

  @Get()
  @Header('Cache-Control', 'no-store, max-age=0, must-revalidate')
  async getPublished() {
    return { data: await this.website.getPublished() };
  }

  @Get('assets/:filename')
  async getAsset(@Param('filename') filename: string, @Res() response: Response) {
    const image = await this.website.readImage(filename);
    response.setHeader('Content-Type', image.mimeType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.send(image.bytes);
  }
}

@Controller('admin/website')
@UseGuards(SuperadminSessionGuard)
export class AdminWebsiteController {
  constructor(private readonly website: WebsiteService) {}

  @Get()
  @Header('Cache-Control', 'no-store, max-age=0, must-revalidate')
  async getDraft() {
    return { data: await this.website.getDraft() };
  }

  @Get('history')
  async getHistory() {
    return { data: await this.website.getHistory() };
  }

  @Put('draft')
  async saveDraft(@Body() dto: SaveWebsiteDraftDto, @Req() request: AuthenticatedRequest) {
    return {
      data: await this.website.saveDraft(dto.content, dto.expectedVersion, request.principal!.id, request.ip),
    };
  }

  @Post('publish')
  async publish(@Body() dto: PublishWebsiteDto, @Req() request: AuthenticatedRequest) {
    return {
      data: await this.website.publishDraft(dto.expectedVersion, request.principal!.id, request.ip),
    };
  }

  @Delete('draft')
  async discard(@Req() request: AuthenticatedRequest) {
    return { data: await this.website.discardDraft(request.principal!.id, request.ip) };
  }

  @Post('assets')
  async uploadAsset(@Body() dto: UploadWebsiteAssetDto) {
    return { data: await this.website.saveImage(dto.data, dto.mimeType) };
  }
}
